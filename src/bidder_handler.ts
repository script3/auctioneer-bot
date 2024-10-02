import { calculateBlockFillAndPercent } from './auction.js';
import { AuctionBid, BidderSubmissionType, BidderSubmitter } from './bidder_submitter.js';
import { AppEvent, EventType } from './events.js';
import { APP_CONFIG } from './utils/config.js';
import { AuctioneerDatabase, AuctionType } from './utils/db.js';
import { stringify } from './utils/json.js';
import { logger } from './utils/logger.js';
import { sendSlackNotification } from './utils/slack_notifier.js';
import { SorobanHelper } from './utils/soroban_helper.js';

export class BidderHandler {
  private db: AuctioneerDatabase;
  private submissionQueue: BidderSubmitter;
  private sorobanHelper: SorobanHelper;

  constructor(
    db: AuctioneerDatabase,
    submissionQueue: BidderSubmitter,
    sorobanHelper: SorobanHelper
  ) {
    this.db = db;
    this.submissionQueue = submissionQueue;
    this.sorobanHelper = sorobanHelper;
  }

  // @dev: No retry / deadletter is implemented here as the only events processed
  // by the bidder do not need to be retried.

  async processEvent(appEvent: AppEvent) {
    switch (appEvent.type) {
      case EventType.LEDGER:
        try {
          const nextLedger = appEvent.ledger + 1;
          const auctions = this.db.getAllAuctionEntries();

          for (let auction of auctions) {
            try {
              const filler = APP_CONFIG.fillers.find(
                (f) => f.keypair.publicKey() === auction.filler
              );
              if (filler === undefined) {
                logger.error(`Filler not found for auction: ${stringify(auction)}`);
                continue;
              }

              if (this.submissionQueue.containsAuction(auction)) {
                // auction already being bid on
                continue;
              }

              const ledgersToFill = auction.fill_block - nextLedger;
              if (auction.fill_block === 0 || ledgersToFill <= 5 || ledgersToFill % 10 === 0) {
                // recalculate the auction
                const auctionData = await this.sorobanHelper.loadAuction(
                  auction.user_id,
                  auction.auction_type
                );
                if (auctionData === undefined) {
                  this.db.deleteAuctionEntry(auction.user_id, auction.auction_type);
                  continue;
                }
                const fillCalculation = await calculateBlockFillAndPercent(
                  filler,
                  auction.auction_type,
                  auctionData,
                  this.sorobanHelper,
                  this.db
                );
                const logMessage =
                  `Auction Calculation\n` +
                  `Type: ${AuctionType[auction.auction_type]}\n` +
                  `User: ${auction.user_id}\n` +
                  `Calculation: ${stringify(fillCalculation, 2)}\n` +
                  `Ledgers To Fill In: ${fillCalculation.fillBlock - nextLedger}\n`;
                if (auction.fill_block === 0) {
                  await sendSlackNotification(logMessage);
                }
                logger.info(logMessage);
                auction.fill_block = fillCalculation.fillBlock;
                auction.updated = appEvent.ledger;
                this.db.setAuctionEntry(auction);
              }

              if (auction.fill_block <= nextLedger) {
                let submission: AuctionBid = {
                  type: BidderSubmissionType.BID,
                  filler: filler,
                  auctionEntry: auction,
                };
                this.submissionQueue.addSubmission(submission, 10);
              }
            } catch (e: any) {
              logger.error(`Error processing block for auction: ${stringify(auction)}`, e);
            }
          }
        } catch (err) {
          logger.error(`Unexpected error in bidder for ${appEvent}`, err);
        }
        break;
      default:
        logger.error(`Unsupported bidder event type: ${appEvent.type}`);
    }
  }
}
