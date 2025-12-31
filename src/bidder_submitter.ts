import { FixedMath, PoolContractV2, ScaledAuction } from '@blend-capital/blend-sdk';
import { rpc, scValToNative } from '@stellar/stellar-sdk';
import { calculateAuctionFill } from './auction.js';
import { getFillerAvailableBalances, managePositions } from './filler.js';
import { APP_CONFIG } from './utils/config.js';
import { AuctioneerDatabase, AuctionEntry, AuctionType } from './utils/db.js';
import { serializeError, stringify } from './utils/json.js';
import { logger } from './utils/logger.js';
import {
  getNotificationLevelForAuction,
  sendNotification,
  NotificationLevel,
} from './utils/notifier.js';
import { SorobanHelper } from './utils/soroban_helper.js';
import { SubmissionQueue } from './utils/submission_queue.js';
import { InterestFillerContract } from './utils/interest_filler.js';

export type BidderSubmission = AuctionBid | FillerUnwind;

export enum BidderSubmissionType {
  BID = 'bid',
  UNWIND = 'unwind',
}

export interface BaseBidderSubmission {
  type: BidderSubmissionType;
}

export interface AuctionBid extends BaseBidderSubmission {
  type: BidderSubmissionType.BID;
  auctionEntry: AuctionEntry;
}

export interface FillerUnwind extends BaseBidderSubmission {
  type: BidderSubmissionType.UNWIND;
  poolId: string;
  filledAuction: ScaledAuction;
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
        auctionBid.auctionEntry.pool_id,
        auctionBid.auctionEntry.user_id,
        auctionBid.auctionEntry.auction_type
      );

      if (auction === undefined) {
        // allow bidder handler to re-process the auction entry
        return true;
      }

      const poolConfig = APP_CONFIG.pools.find(
        (p) => p.poolAddress === auctionBid.auctionEntry.pool_id
      );
      if (!poolConfig) {
        // allow bidder handler to re-process the auction entry
        return true;
      }

      const fill = await calculateAuctionFill(
        poolConfig,
        auction,
        nextLedger,
        sorobanHelper,
        this.db
      );

      if (nextLedger >= fill.block) {
        const pool = new PoolContractV2(auctionBid.auctionEntry.pool_id);
        const est_profit = fill.lotValue - fill.bidValue;
        // include high inclusion fee if the estimated profit is over $10
        if (est_profit > 10) {
          // this object gets recreated every time, so no need to reset the fee level
          sorobanHelper.setFeeLevel('high');
        }
        let result;
        // use the interest auction filler if it exists and the auction is an interest auction
        if (
          APP_CONFIG.interestFillerAddress !== undefined &&
          APP_CONFIG.interestFillerAddress !== '' &&
          auctionBid.auctionEntry.auction_type == AuctionType.Interest &&
          fill.percent === 100
        ) {
          logger.info(`Using interest auction filler contract ${APP_CONFIG.interestFillerAddress}`);
          const filler_contract = new InterestFillerContract(APP_CONFIG.interestFillerAddress);
          result = await sorobanHelper.submitTransaction(
            filler_contract.fill_interest(
              auctionBid.auctionEntry.filler,
              auctionBid.auctionEntry.pool_id,
              fill.percent,
              FixedMath.toFixed(fill.bidValue * 1.01)
            ),
            APP_CONFIG.fillerKeypair
          );
        } else {
          result = await sorobanHelper.submitTransaction(
            pool.submit({
              from: auctionBid.auctionEntry.filler,
              spender: auctionBid.auctionEntry.filler,
              to: auctionBid.auctionEntry.filler,
              requests: fill.requests,
            }),
            APP_CONFIG.fillerKeypair
          );
        }
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
            poolId: auctionBid.auctionEntry.pool_id,
            filledAuction: scaledAuction,
          },
          2
        );
        let logMessage =
          `Successful bid on auction\n` +
          `Type: ${AuctionType[auctionBid.auctionEntry.auction_type]}\n` +
          `Pool: ${auctionBid.auctionEntry.pool_id}\n` +
          `User: ${auctionBid.auctionEntry.user_id}\n` +
          `Filler: ${APP_CONFIG.fillerKeypair.publicKey()}\n` +
          `Fill Percent ${fill.percent}\n` +
          `Ledger Fill Delta ${result.ledger - auctionBid.auctionEntry.start_block}\n` +
          `Hash ${result.txHash}\n`;
        await sendNotification(
          logMessage,
          getNotificationLevelForAuction(auctionBid.auctionEntry.auction_type, true)
        );
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
        `Filler: ${APP_CONFIG.fillerKeypair.publicKey()}\n` +
        `Error: ${stringify(serializeError(e))}`;
      await sendNotification(
        logMessage,
        getNotificationLevelForAuction(auctionBid.auctionEntry.auction_type, false)
      );
      logger.error(logMessage, e);
      return false;
    }
  }

  async submitUnwind(sorobanHelper: SorobanHelper, fillerUnwind: FillerUnwind): Promise<boolean> {
    logger.info(
      `Submitting unwind for filler ${APP_CONFIG.fillerKeypair.publicKey()} for auction type ${AuctionType[fillerUnwind.filledAuction.type]} in pool ${fillerUnwind.poolId}`
    );

    switch (fillerUnwind.filledAuction.type) {
      case AuctionType.Interest: {
        // claim tokens from the interest auction filler contract
        const lot_tokens = Array.from(fillerUnwind.filledAuction.data.lot.keys());
        const interest_filler_contract = new InterestFillerContract(
          APP_CONFIG.interestFillerAddress
        );
        const op = interest_filler_contract.claim(APP_CONFIG.fillerKeypair.publicKey(), lot_tokens);
        const result = await sorobanHelper.submitTransaction(op, APP_CONFIG.fillerKeypair);
        let returnVal = undefined;
        if (result.returnValue !== undefined) {
          returnVal = scValToNative(result.returnValue);
        }
        logger.info(
          `Successful claim from interest filler contract for filler: ${APP_CONFIG.fillerKeypair.publicKey()}\n` +
            `Pool: ${fillerUnwind.poolId}\n` +
            `Ledger: ${result.ledger}\n` +
            `Hash: ${result.txHash}\n` +
            `Return Value: ${stringify(returnVal)}`
        );
        break;
      }
      case AuctionType.Liquidation:
      case AuctionType.BadDebt: {
        const filler_pubkey = APP_CONFIG.fillerKeypair.publicKey();
        const poolConfig = APP_CONFIG.pools.find(
          (pool) => pool.poolAddress === fillerUnwind.poolId
        );
        if (!poolConfig) {
          logger.error(
            `Filler ${APP_CONFIG.fillerKeypair.publicKey()} does not support pool: ${fillerUnwind.poolId}`
          );
          return false;
        }
        const pool = await sorobanHelper.loadPool(fillerUnwind.poolId);
        const poolOracle = await sorobanHelper.loadPoolOracle(fillerUnwind.poolId);
        const filler_user = await sorobanHelper.loadUser(fillerUnwind.poolId, filler_pubkey);
        const filler_tokens = [...new Set([poolConfig.primaryAsset, ...pool.metadata.reserveList])];
        const filler_balances = await getFillerAvailableBalances(filler_tokens, sorobanHelper);

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
          poolConfig,
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
            APP_CONFIG.fillerKeypair
          );
          logger.info(
            `Successful unwind for filler: ${APP_CONFIG.fillerKeypair.publicKey()}\n` +
              `Pool: ${fillerUnwind.poolId}\n` +
              `Ledger: ${result.ledger}\n` +
              `Hash: ${result.txHash}`
          );
          this.addSubmission(
            {
              type: BidderSubmissionType.UNWIND,
              poolId: fillerUnwind.poolId,
              filledAuction: fillerUnwind.filledAuction,
            },
            2
          );
          return true;
        }

        // notify slack if the filler has any remaining liabilities
        if (filler_user.positions.liabilities.size > 0) {
          const logMessage =
            `Filler has liabilities that cannot be removed\n` +
            `Filler: ${APP_CONFIG.fillerKeypair.publicKey()}\n` +
            `Pool: ${fillerUnwind.poolId}\n` +
            `Positions: ${stringify(filler_user.positions, 2)}`;
          logger.info(logMessage);
          await sendNotification(logMessage, NotificationLevel.HIGH);
          return true;
        }

        logger.info(`Filler has no positions to manage, stopping unwind events.`);
        break;
      }
      default:
        logger.error(`Invalid auction for unwind: ${stringify(fillerUnwind.filledAuction)}`);
        return true;
    }
    return true;
  }

  async onDrop(submission: BidderSubmission): Promise<void> {
    let logMessage: string = '';
    switch (submission.type) {
      case BidderSubmissionType.BID:
        logMessage =
          `Dropped auction bid\n` +
          `Type: ${AuctionType[submission.auctionEntry.auction_type]}\n` +
          `Pool: ${submission.auctionEntry.pool_id}\n` +
          `User: ${submission.auctionEntry.user_id}\n` +
          `Start Block: ${submission.auctionEntry.start_block}\n` +
          `Fill Block: ${submission.auctionEntry.fill_block}\n` +
          `Filler: ${APP_CONFIG.fillerKeypair.publicKey()}\n`;
        break;
      case BidderSubmissionType.UNWIND:
        logMessage =
          `Dropped filler unwind\n` +
          `Filler: ${APP_CONFIG.fillerKeypair.publicKey()}\n` +
          `Pool: ${submission.poolId}`;
        break;
    }
    logger.error(logMessage);
    await sendNotification(logMessage, NotificationLevel.HIGH);
  }
}
