import { calculateAuctionFill } from './auction.js';
import { AuctionBid, BidderSubmissionType, BidderSubmitter } from './bidder_submitter.js';
import { AppEvent, EventType } from './events.js';
import { APP_CONFIG } from './utils/config.js';
import { AuctioneerDatabase, AuctionType } from './utils/db.js';
import { stringify } from './utils/json.js';
import { logger } from './utils/logger.js';
import { getNotificationLevelForAuction, sendNotification } from './utils/notifier.js';
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

          for (let auctionEntry of auctions) {
            try {
              if (this.submissionQueue.containsAuction(auctionEntry)) {
                // auction already being bid on
                continue;
              }

              const poolConfig = APP_CONFIG.pools.find(
                (p) => p.poolAddress === auctionEntry.pool_id
              );
              if (!poolConfig) {
                logger.error(
                  `Pool config not found for auction entry: ${stringify(auctionEntry)}. Deleting auction: ${stringify(auctionEntry)}`
                );
                this.db.deleteAuctionEntry(
                  auctionEntry.pool_id,
                  auctionEntry.user_id,
                  auctionEntry.auction_type
                );
                continue;
              }

              const ledgersToFill = auctionEntry.fill_block - nextLedger;
              if (auctionEntry.fill_block === 0 || ledgersToFill <= 5 || ledgersToFill % 10 === 0) {
                // recalculate the auction
                const auction = await this.sorobanHelper.loadAuction(
                  auctionEntry.pool_id,
                  auctionEntry.user_id,
                  auctionEntry.auction_type
                );
                if (auction === undefined) {
                  logger.info(
                    `Auction not found. Assuming auction was deleted or filled. Deleting auction: ${stringify(auctionEntry)}`
                  );
                  this.db.deleteAuctionEntry(
                    auctionEntry.pool_id,
                    auctionEntry.user_id,
                    auctionEntry.auction_type
                  );
                  continue;
                }
                const fill = await calculateAuctionFill(
                  poolConfig,
                  auction,
                  nextLedger,
                  this.sorobanHelper,
                  this.db
                );
                const logMessage =
                  `Auction Calculation\n` +
                  `Filler: ${APP_CONFIG.fillerKeypair.publicKey()}\n` +
                  `Type: ${AuctionType[auction.type]}\n` +
                  `Pool: ${auctionEntry.pool_id}\n` +
                  `User: ${auction.user}\n` +
                  `Fill: ${stringify(fill, 2)}\n` +
                  `Ledgers To Fill In: ${fill.block - nextLedger}\n`;
                if (auctionEntry.fill_block === 0) {
                  await sendNotification(
                    logMessage,
                    getNotificationLevelForAuction(auction.type, false)
                  );
                }
                logger.info(logMessage);
                auctionEntry.fill_block = fill.block;
                auctionEntry.updated = appEvent.ledger;
                this.db.setAuctionEntry(auctionEntry);
              }
              if (auctionEntry.fill_block <= nextLedger) {
                let submission: AuctionBid = {
                  type: BidderSubmissionType.BID,
                  auctionEntry: auctionEntry,
                };
                this.submissionQueue.addSubmission(submission, 10);
              }
            } catch (e: any) {
              logger.error(`Error processing block for auction: ${stringify(auctionEntry)}`, e);
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
