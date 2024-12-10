import { PoolContract } from '@blend-capital/blend-sdk';
import { rpc } from '@stellar/stellar-sdk';
import { calculateAuctionFill } from './auction.js';
import { getFillerAvailableBalances, managePositions } from './filler.js';
import { APP_CONFIG, Filler } from './utils/config.js';
import { AuctioneerDatabase, AuctionEntry, AuctionType } from './utils/db.js';
import { serializeError, stringify } from './utils/json.js';
import { logger } from './utils/logger.js';
import { sendSlackNotification } from './utils/slack_notifier.js';
import { SorobanHelper } from './utils/soroban_helper.js';
import { SubmissionQueue } from './utils/submission_queue.js';

export type BidderSubmission = AuctionBid | FillerUnwind;

export enum BidderSubmissionType {
  BID = 'bid',
  UNWIND = 'unwind',
}

export interface AuctionBid {
  type: BidderSubmissionType.BID;
  filler: Filler;
  auctionEntry: AuctionEntry;
}

export interface FillerUnwind {
  type: BidderSubmissionType.UNWIND;
  filler: Filler;
}

export class BidderSubmitter extends SubmissionQueue<BidderSubmission> {
  db: AuctioneerDatabase;

  constructor(db: AuctioneerDatabase) {
    super();
    this.db = db;
  }

  /**
   * Returns true if the auction entry is already in the submission queue
   * @param auctionEntry - The auction entry to check
   */
  containsAuction(auctionEntry: AuctionEntry): boolean {
    return this.submissions.some((submission) => {
      if (submission.submission.type === BidderSubmissionType.BID) {
        return (
          submission.submission.auctionEntry.auction_type === auctionEntry.auction_type &&
          submission.submission.auctionEntry.user_id === auctionEntry.user_id
        );
      }
      return false;
    });
  }

  // @dev: Return true to acknowledge the submission, or false to retry
  async submit(submission: BidderSubmission): Promise<boolean> {
    let sorobanHelper = new SorobanHelper();

    switch (submission.type) {
      case BidderSubmissionType.BID:
        return this.submitBid(sorobanHelper, submission);
      case BidderSubmissionType.UNWIND:
        return this.submitUnwind(sorobanHelper, submission);
      default:
        logger.error(`Invalid submission type: ${stringify(submission)}`);
        // consume the submission
        return true;
    }
  }

  async submitBid(sorobanHelper: SorobanHelper, auctionBid: AuctionBid): Promise<boolean> {
    try {
      logger.info(`Submitting bid for auction ${stringify(auctionBid.auctionEntry, 2)}`);
      const currLedger = (
        await new rpc.Server(
          sorobanHelper.network.rpc,
          sorobanHelper.network.opts
        ).getLatestLedger()
      ).sequence;
      const nextLedger = currLedger + 1;

      const auction = await sorobanHelper.loadAuction(
        auctionBid.auctionEntry.user_id,
        auctionBid.auctionEntry.auction_type
      );

      if (auction === undefined) {
        // allow bidder handler to re-process the auction entry
        return true;
      }

      const fill = await calculateAuctionFill(
        auctionBid.filler,
        auction,
        nextLedger,
        sorobanHelper,
        this.db
      );

      if (nextLedger >= fill.block) {
        const pool = new PoolContract(APP_CONFIG.poolAddress);

        const result = await sorobanHelper.submitTransaction(
          pool.submit({
            from: auctionBid.auctionEntry.filler,
            spender: auctionBid.auctionEntry.filler,
            to: auctionBid.auctionEntry.filler,
            requests: fill.requests,
          }),
          auctionBid.filler.keypair
        );
        const [scaledAuction] = auction.scale(result.ledger, fill.percent);
        this.db.setFilledAuctionEntry({
          tx_hash: result.txHash,
          filler: auctionBid.auctionEntry.filler,
          user_id: auctionBid.auctionEntry.user_id,
          auction_type: auctionBid.auctionEntry.auction_type,
          bid: scaledAuction.data.bid,
          bid_total: fill.bidValue,
          lot: scaledAuction.data.lot,
          lot_total: fill.lotValue,
          est_profit: fill.lotValue - fill.bidValue,
          fill_block: result.ledger,
          timestamp: result.latestLedgerCloseTime,
        });
        this.addSubmission({ type: BidderSubmissionType.UNWIND, filler: auctionBid.filler }, 2);
        let logMessage =
          `Successful bid on auction\n` +
          `Type: ${AuctionType[auctionBid.auctionEntry.auction_type]}\n` +
          `User: ${auctionBid.auctionEntry.user_id}\n` +
          `Filler: ${auctionBid.filler.name}\n` +
          `Fill Percent ${fill.percent}\n` +
          `Ledger Fill Delta ${result.ledger - auctionBid.auctionEntry.start_block}\n` +
          `Hash ${result.txHash}\n`;
        await sendSlackNotification(logMessage);
        logger.info(logMessage);
        return true;
      }
      // allow bidder handler to re-process the auction entry
      return true;
    } catch (e: any) {
      const logMessage =
        `Error submitting fill for auction\n` +
        `Type: ${auctionBid.auctionEntry.auction_type}\n` +
        `User: ${auctionBid.auctionEntry.user_id}\n` +
        `Filler: ${auctionBid.filler.name}`;
      await sendSlackNotification(
        `<!channel> ` + logMessage + `\nError: ${stringify(serializeError(e))}`
      );
      logger.error(logMessage, e);
      return false;
    }
  }

  async submitUnwind(sorobanHelper: SorobanHelper, fillerUnwind: FillerUnwind): Promise<boolean> {
    logger.info(`Submitting unwind for filler ${fillerUnwind.filler.keypair.publicKey()}`);
    const filler_pubkey = fillerUnwind.filler.keypair.publicKey();
    const filler_tokens = [
      ...new Set([
        fillerUnwind.filler.primaryAsset,
        ...fillerUnwind.filler.supportedBid,
        ...fillerUnwind.filler.supportedLot,
      ]),
    ];
    const pool = await sorobanHelper.loadPool();
    const poolOracle = await sorobanHelper.loadPoolOracle();
    const filler_user = await sorobanHelper.loadUser(filler_pubkey);
    const filler_balances = await getFillerAvailableBalances(
      fillerUnwind.filler,
      filler_tokens,
      sorobanHelper
    );

    // Unwind the filler one step at a time. If the filler is not unwound, place another `FillerUnwind` event on the submission queue.
    // To unwind the filler, the following actions will be taken in order:
    // 1. Unwind the filler's pool position by paying off all liabilities with current balances and withdrawing all possible collateral,
    //    down to either the min_collateral or min_health_factor.
    // TODO: Add trading functionality for 2, 3
    // 2. If no positions can be modified, and the filler still has outstanding liabilities, attempt to purchase the liability tokens
    //    with USDC.
    // 3. If there are no liabilities, attempt to sell un-needed tokens for USDC
    // 4. If this case is reached, stop sending unwind events for the filler.

    // 1
    let requests = managePositions(
      fillerUnwind.filler,
      pool,
      poolOracle,
      filler_user.positions,
      filler_balances
    );
    if (requests.length > 0) {
      logger.info('Unwind found positions to manage', requests);
      // some positions to manage - submit the transaction
      const pool_contract = new PoolContract(APP_CONFIG.poolAddress);
      const result = await sorobanHelper.submitTransaction(
        pool_contract.submit({
          from: filler_pubkey,
          spender: filler_pubkey,
          to: filler_pubkey,
          requests: requests,
        }),
        fillerUnwind.filler.keypair
      );
      logger.info(
        `Successful unwind for filler: ${fillerUnwind.filler.name}\n` +
          `Ledger: ${result.ledger}\n` +
          `Hash: ${result.txHash}`
      );
      this.addSubmission({ type: BidderSubmissionType.UNWIND, filler: fillerUnwind.filler }, 2);
      return true;
    }

    if (filler_user.positions.liabilities.size > 0) {
      const logMessage =
        `Filler has liabilities that cannot be removed\n` +
        `Filler: ${fillerUnwind.filler.name}\n` +
        `Positions: ${stringify(filler_user.positions, 2)}`;
      logger.info(logMessage);
      await sendSlackNotification(logMessage);
      return true;
    }

    logger.info(`Filler has no positions to manage, stopping unwind events.`);
    return true;
  }

  async onDrop(submission: BidderSubmission): Promise<void> {
    let logMessage: string;
    switch (submission.type) {
      case BidderSubmissionType.BID:
        logMessage =
          `Dropped auction bid\n` +
          `Type: ${AuctionType[submission.auctionEntry.auction_type]}\n` +
          `User: ${submission.auctionEntry.user_id}\n` +
          `Start Block: ${submission.auctionEntry.start_block}\n` +
          `Fill Block: ${submission.auctionEntry.fill_block}\n` +
          `Filler: ${submission.filler.name}\n`;
        break;
      case BidderSubmissionType.UNWIND:
        logMessage = `Dropped filler unwind\n` + `Filler: ${submission.filler.name}\n`;
        break;
    }
    logger.error(logMessage);
    await sendSlackNotification(logMessage);
  }
}
