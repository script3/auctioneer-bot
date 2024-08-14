import { AuctionBid, BidderSubmissionType, BidderSubmitter } from './bidder_submitter.js';
import { EventType } from './events.js';
import { APP_CONFIG } from './utils/config.js';
import { AuctioneerDatabase, AuctionType } from './utils/db.js';
import { stringify } from './utils/json.js';
import { logger } from './utils/logger.js';
import { readEvent } from './utils/messages.js';

export interface OngoingAuction {
  auctionType: AuctionType;
  userId: string;
  retriesRemaining: number;
}

async function main() {
  const db = AuctioneerDatabase.connect();
  const submissionQueue = new BidderSubmitter(db);

  process.on('message', async (message: any) => {
    let appEvent = readEvent(message);
    if (appEvent?.type === EventType.LEDGER) {
      try {
        const timer = Date.now();
        const nextLedger = appEvent.ledger + 1;
        logger.info(`Processing for ledger: ${nextLedger}`);
        const auctions = db.getAllAuctionEntries();

        for (let auction of auctions) {
          const filler = APP_CONFIG.fillers.find((f) => f.keypair.publicKey() === auction.filler);
          if (filler === undefined) {
            logger.error(`Filler not found for auction: ${stringify(auction)}`);
            continue;
          }

          let ledgersToFill = nextLedger - auction.fill_block;
          if (auction.fill_block === 0 || ledgersToFill <= 5 || ledgersToFill % 10 === 0) {
            // recalculate the auction
            // TODO: update calc to fill and update auction entry in db
          }

          // TODO: Add other fill conditions like force fill
          if (auction.fill_block <= nextLedger) {
            if (!submissionQueue.containsAuction(auction)) {
              let submission: AuctionBid = {
                type: BidderSubmissionType.BID,
                filler: filler,
                auctionEntry: auction,
              };
              submissionQueue.addSubmission(submission, 10);
            }
          }
        }

        logger.info(
          `Finished: ${message?.data} in ${Date.now() - timer}ms with delay ${timer - appEvent.timestamp}ms`
        );
      } catch (err) {
        logger.error(`Unexpected error in bidder for ${message?.data}`, err);
      }
    } else {
      logger.error(`Invalid event read, message: ${message}`);
    }
  });

  process.on('SIGTERM', () => {
    db.close();
    process.exit(0);
  });

  process.on('SIGINT', () => {
    db.close();
    process.exit(0);
  });

  process.on('error', (error) => {
    console.error('Bidder errored.', error);
    db.close();
    process.exit(1);
  });

  console.log('Bidder listening for blocks...');
}

main().catch((error) => {
  console.error('Unhandled error in bidder', error);
  process.exit(1);
});
