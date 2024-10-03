import { PoolContract } from '@blend-capital/blend-sdk';
import { SorobanRpc } from '@stellar/stellar-sdk';
import {
  buildFillRequests,
  calculateAuctionValue,
  calculateBlockFillAndPercent,
  scaleAuction,
} from './auction.js';
import { APP_CONFIG, Filler } from './utils/config.js';
import { AuctioneerDatabase, AuctionEntry, AuctionType } from './utils/db.js';
import { stringify } from './utils/json.js';
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
      const currLedger = (
        await new SorobanRpc.Server(
          sorobanHelper.network.rpc,
          sorobanHelper.network.opts
        ).getLatestLedger()
      ).sequence;

      const auctionData = await sorobanHelper.loadAuction(
        auctionBid.auctionEntry.user_id,
        auctionBid.auctionEntry.auction_type
      );

      // Auction has been filled remove from the database
      if (auctionData === undefined) {
        this.db.deleteAuctionEntry(
          auctionBid.auctionEntry.user_id,
          auctionBid.auctionEntry.auction_type
        );
        return true;
      }

      const fillCalculation = await calculateBlockFillAndPercent(
        auctionBid.filler,
        auctionBid.auctionEntry.auction_type,
        auctionData,
        sorobanHelper,
        this.db
      );

      if (currLedger + 1 >= fillCalculation.fillBlock) {
        let scaledAuction = scaleAuction(auctionData, currLedger, fillCalculation.fillPercent);
        const requests = await buildFillRequests(
          auctionBid,
          scaledAuction,
          fillCalculation.fillPercent,
          sorobanHelper
        );
        const pool = new PoolContract(APP_CONFIG.poolAddress);

        const result = await sorobanHelper.submitTransaction(
          pool.submit({
            from: auctionBid.auctionEntry.filler,
            spender: auctionBid.auctionEntry.filler,
            to: auctionBid.auctionEntry.filler,
            requests: requests,
          }),
          auctionBid.filler.keypair
        );
        const filledAuction = scaleAuction(auctionData, result.ledger, fillCalculation.fillPercent);
        const filledAuctionValue = await calculateAuctionValue(
          auctionBid.auctionEntry.auction_type,
          filledAuction,
          sorobanHelper,
          this.db
        );
        let logMessage =
          `Successful bid on auction\n` +
          `Type: ${AuctionType[auctionBid.auctionEntry.auction_type]}\n` +
          `User: ${auctionBid.auctionEntry.user_id}\n` +
          `Filler: ${auctionBid.filler.name}\n` +
          `Fill Percent ${fillCalculation.fillPercent}\n` +
          `Ledger Fill Delta ${result.ledger - auctionBid.auctionEntry.start_block}\n` +
          `Hash ${result.txHash}\n`;
        await sendSlackNotification(logMessage);
        logger.info(logMessage);
        this.db.setFilledAuctionEntry({
          tx_hash: result.txHash,
          filler: auctionBid.auctionEntry.filler,
          user_id: auctionBid.auctionEntry.filler,
          auction_type: auctionBid.auctionEntry.auction_type,
          bid: filledAuction.bid,
          bid_total: filledAuctionValue.bidValue,
          lot: filledAuction.lot,
          lot_total: filledAuctionValue.lotValue,
          est_profit: filledAuctionValue.lotValue - filledAuctionValue.bidValue,
          fill_block: result.ledger,
          timestamp: result.latestLedgerCloseTime,
        });
        return true;
      }
      return true;
    } catch (e: any) {
      const logMessage =
        `Error submitting fill for auction\n` +
        `Type: ${auctionBid.auctionEntry.auction_type}\n` +
        `User: ${auctionBid.auctionEntry.user_id}\n` +
        `Filler: ${auctionBid.filler.name}\nError: ${e}\n`;
      await sendSlackNotification(`<!channel>` + logMessage);
      logger.error(logMessage);
      return false;
    }
  }

  async submitUnwind(sorobanHelper: SorobanHelper, fillerUnwind: FillerUnwind): Promise<boolean> {
    logger.warn('Filler unwind is not implemented.');
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
