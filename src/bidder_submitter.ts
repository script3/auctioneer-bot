import { FixedMath, PoolContractV2 } from '@blend-capital/blend-sdk';
import { Address, Contract, nativeToScVal, rpc } from '@stellar/stellar-sdk';
import { calculateAuctionFill } from './auction.js';
import { getFillerAvailableBalances, managePositions } from './filler.js';
import { APP_CONFIG, Filler } from './utils/config.js';
import { AuctioneerDatabase, AuctionEntry, AuctionType } from './utils/db.js';
import { serializeError, stringify } from './utils/json.js';
import { logger } from './utils/logger.js';
import { sendNotification } from './utils/notifier.js';
import { SorobanHelper } from './utils/soroban_helper.js';
import { SubmissionQueue } from './utils/submission_queue.js';

export type BidderSubmission = AuctionBid | FillerUnwind | AddAllowance;

export enum BidderSubmissionType {
  BID = 'bid',
  UNWIND = 'unwind',
  ADD_ALLOWANCE = 'add_allowance',
}

export interface BaseBidderSubmission {
  type: BidderSubmissionType;
}

export interface AuctionBid extends BaseBidderSubmission {
  type: BidderSubmissionType.BID;
  filler: Filler;
  auctionEntry: AuctionEntry;
}

export interface FillerUnwind extends BaseBidderSubmission {
  type: BidderSubmissionType.UNWIND;
  poolId: string;
  filler: Filler;
}

/**
 * Event to check for allowance updates.
 */
export interface AddAllowance extends BaseBidderSubmission {
  type: BidderSubmissionType.ADD_ALLOWANCE;
  filler: Filler;
  assetId: string;
  spender: string;
  currLedger: number;
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
      case BidderSubmissionType.ADD_ALLOWANCE:
        return this.submitAddAllowance(sorobanHelper, submission);
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
        auctionBid.auctionEntry.pool_id,
        auctionBid.auctionEntry.user_id,
        auctionBid.auctionEntry.auction_type
      );

      if (auction === undefined) {
        // allow bidder handler to re-process the auction entry
        return true;
      }

      const fill = await calculateAuctionFill(
        auctionBid.auctionEntry.pool_id,
        auctionBid.filler,
        auction,
        nextLedger,
        sorobanHelper,
        this.db
      );

      if (nextLedger >= fill.block) {
        const pool = new PoolContractV2(auctionBid.auctionEntry.pool_id);
        const est_profit = fill.lotValue - fill.bidValue;
        // include high inclusion fee if the esimated profit is over $10
        if (est_profit > 10) {
          // this object gets recreated every time, so no need to reset the fee level
          sorobanHelper.setFeeLevel('high');
        }

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
          pool_id: auctionBid.auctionEntry.pool_id,
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
        this.addSubmission(
          {
            type: BidderSubmissionType.UNWIND,
            filler: auctionBid.filler,
            poolId: auctionBid.auctionEntry.pool_id,
          },
          2
        );
        let logMessage =
          `Successful bid on auction\n` +
          `Type: ${AuctionType[auctionBid.auctionEntry.auction_type]}\n` +
          `Pool: ${auctionBid.auctionEntry.pool_id}\n` +
          `User: ${auctionBid.auctionEntry.user_id}\n` +
          `Filler: ${auctionBid.filler.name}\n` +
          `Fill Percent ${fill.percent}\n` +
          `Ledger Fill Delta ${result.ledger - auctionBid.auctionEntry.start_block}\n` +
          `Hash ${result.txHash}\n`;
        await sendNotification(logMessage);
        logger.info(logMessage);
        return true;
      } else {
        logger.info(
          `Fill ledger not reached for auction bid\n` +
          `Type: ${auctionBid.auctionEntry.auction_type}\n` +
          `Pool: ${auctionBid.auctionEntry.pool_id}\n` +
          `User: ${auctionBid.auctionEntry.user_id}\n` +
          `Fill Ledger: ${fill.block} Next Ledger: ${nextLedger}`
        );
      }
      // allow bidder handler to re-process the auction entry
      return true;
    } catch (e: any) {
      const logMessage =
        `Error submitting fill for auction\n` +
        `Type: ${AuctionType[auctionBid.auctionEntry.auction_type]}\n` +
        `Pool: ${auctionBid.auctionEntry.pool_id}\n` +
        `User: ${auctionBid.auctionEntry.user_id}\n` +
        `Filler: ${auctionBid.filler.name}\n` +
        `Error: ${stringify(serializeError(e))}`;
      await sendNotification(logMessage, true);
      logger.error(logMessage, e);
      return false;
    }
  }

  async submitUnwind(sorobanHelper: SorobanHelper, fillerUnwind: FillerUnwind): Promise<boolean> {
    logger.info(`Submitting unwind for filler ${fillerUnwind.filler.keypair.publicKey()}`);
    const filler_pubkey = fillerUnwind.filler.keypair.publicKey();
    const fillerPrimaryAsset = fillerUnwind.filler.supportedPools.find(
      (pool) => pool.poolAddress === fillerUnwind.poolId
    )?.primaryAsset;
    if (!fillerPrimaryAsset) {
      logger.error(
        `Filler ${fillerUnwind.filler.name} does not support pool: ${fillerUnwind.poolId}`
      );
      return false;
    }
    const filler_tokens = [
      ...new Set([
        fillerPrimaryAsset,
        ...fillerUnwind.filler.supportedBid,
        ...fillerUnwind.filler.supportedLot,
      ]),
    ];
    const pool = await sorobanHelper.loadPool(fillerUnwind.poolId);
    const poolOracle = await sorobanHelper.loadPoolOracle(fillerUnwind.poolId);
    const filler_user = await sorobanHelper.loadUser(fillerUnwind.poolId, filler_pubkey);
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
      const pool = new PoolContractV2(fillerUnwind.poolId);
      const result = await sorobanHelper.submitTransaction(
        pool.submit({
          from: filler_pubkey,
          spender: filler_pubkey,
          to: filler_pubkey,
          requests: requests,
        }),
        fillerUnwind.filler.keypair
      );
      logger.info(
        `Successful unwind for filler: ${fillerUnwind.filler.name}\n` +
        `Pool: ${fillerUnwind.poolId}\n` +
        `Ledger: ${result.ledger}\n` +
        `Hash: ${result.txHash}`
      );
      this.addSubmission(
        {
          type: BidderSubmissionType.UNWIND,
          filler: fillerUnwind.filler,
          poolId: fillerUnwind.poolId,
        },
        2
      );
      return true;
    }

    // notify slack if the filler supports interest auctions and has low backstop token balance
    if (fillerUnwind.filler.supportedBid.includes(APP_CONFIG.backstopTokenAddress)) {
      const backstopTokenBalance = filler_balances.get(APP_CONFIG.backstopTokenAddress);
      const backstopToken = await sorobanHelper.loadBackstopToken();
      const tokenBalanceFloat = FixedMath.toFloat(backstopTokenBalance ?? BigInt(0));
      if (tokenBalanceFloat * backstopToken.lpTokenPrice < 300) {
        const logMessage =
          `Filler has low balance of backstop tokens\n` +
          `Filler: ${fillerUnwind.filler.name}\n` +
          `Backstop Token Balance: ${tokenBalanceFloat}`;
        logger.info(logMessage);
        await sendNotification(logMessage);
      }
    }

    // notify slack if the filler has any remaining liabilities
    if (filler_user.positions.liabilities.size > 0) {
      const logMessage =
        `Filler has liabilities that cannot be removed\n` +
        `Filler: ${fillerUnwind.filler.name}\n` +
        `Pool: ${fillerUnwind.poolId}\n` +
        `Positions: ${stringify(filler_user.positions, 2)}`;
      logger.info(logMessage);
      await sendNotification(logMessage);
      return true;
    }

    logger.info(`Filler has no positions to manage, stopping unwind events.`);
    return true;
  }

  async submitAddAllowance(
    sorobanHelper: SorobanHelper,
    allowance: AddAllowance
  ): Promise<boolean> {
    try {
      const allowanceData = await sorobanHelper.loadAllowance(
        allowance.assetId,
        allowance.filler.keypair.publicKey(),
        allowance.spender
      );
      if (
        allowanceData.amount < BigInt(100_000e7) ||
        allowanceData.expiration_ledger < allowance.currLedger + 17368 * 7
      ) {
        const assetContract = new Contract(allowance.assetId);
        const op = assetContract
          .call(
            'approve',
            ...[
              Address.fromString(allowance.filler.keypair.publicKey()).toScVal(),
              Address.fromString(allowance.spender).toScVal(),
              nativeToScVal(BigInt('18446744073709551615'), { type: 'i128' }),
              nativeToScVal(allowance.currLedger + 17368 * 30 * 5, { type: 'u32' }),
            ]
          )
          .toXDR('base64');
        await sorobanHelper.submitTransaction(op, allowance.filler.keypair);

        const logMessage =
          `Successfully updated allowance\n` +
          `Filler: ${allowance.filler.name}\n` +
          `Spender: ${allowance.spender}\n` +
          `Asset: ${allowance.assetId}\n`;
        logger.info(logMessage);
        return true; // TODO: Check for error in response
      }
      return true;
    } catch (e) {
      return false;
    }
  }
  async onDrop(submission: BidderSubmission): Promise<void> {
    let logMessage: string;
    switch (submission.type) {
      case BidderSubmissionType.BID:
        logMessage =
          `Dropped auction bid\n` +
          `Type: ${AuctionType[submission.auctionEntry.auction_type]}\n` +
          `Pool: ${submission.auctionEntry.pool_id}\n` +
          `User: ${submission.auctionEntry.user_id}\n` +
          `Start Block: ${submission.auctionEntry.start_block}\n` +
          `Fill Block: ${submission.auctionEntry.fill_block}\n` +
          `Filler: ${submission.filler.name}\n`;
        break;
      case BidderSubmissionType.UNWIND:
        logMessage =
          `Dropped filler unwind\n` +
          `Filler: ${submission.filler.name}\n` +
          `Pool: ${submission.poolId}`;
        break;
      case BidderSubmissionType.ADD_ALLOWANCE:
        logMessage =
          `Dropped allowance check\n` +
          `Filler: ${submission.filler.name}\n` +
          `Spender: ${submission.spender}\n` +
          `Asset: ${submission.assetId}\n` +
          `Ledger: ${submission.currLedger}`;
        break;
    }
    logger.error(logMessage);
    await sendNotification(logMessage);
  }
}
