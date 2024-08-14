import { BlendHelper } from './utils/blend_helper.js';
import { Filler } from './utils/config.js';
import { AuctioneerDatabase, AuctionEntry } from './utils/db.js';
import { stringify } from './utils/json.js';
import { logger } from './utils/logger.js';
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
    let blendHelper = new BlendHelper();

    switch (submission.type) {
      case BidderSubmissionType.BID:
        return this.submitBid(blendHelper, submission);
      case BidderSubmissionType.UNWIND:
        return this.submitUnwind(blendHelper, submission);
      default:
        logger.error(`Invalid submission type: ${stringify(submission)}`);
        // consume the submission
        return true;
    }
  }

  async submitBid(blendHelper: BlendHelper, auctionBid: AuctionBid): Promise<boolean> {
    logger.warn('Auction bid is not implemented.');
    return true;
  }

  async submitUnwind(blendHelper: BlendHelper, fillerUnwind: FillerUnwind): Promise<boolean> {
    logger.warn('Filler unwind is not implemented.');
    return true;
  }
}
