import { calculateBlockFillAndPercent } from './auction.js';
import { AuctionBid, BidderSubmissionType, BidderSubmitter } from './bidder_submitter.js';
import { EventType } from './events.js';
import { APP_CONFIG } from './utils/config.js';
import { AuctioneerDatabase, AuctionType } from './utils/db.js';
import { stringify } from './utils/json.js';
import { logger } from './utils/logger.js';
import { readEvent } from './utils/messages.js';
import { SorobanHelper } from './utils/soroban_helper.js';

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
        const sorobanHelper = new SorobanHelper();

        for (let auction of auctions) {
          const filler = APP_CONFIG.fillers.find((f) => f.keypair.publicKey() === auction.filler);
          if (filler === undefined) {
            logger.error(`Filler not found for auction: ${stringify(auction)}`);
            continue;
          }

          if (submissionQueue.containsAuction(auction)) {
            // auction already being bid on
            continue;
          }

          const ledgersToFill = auction.fill_block - nextLedger;
          if (auction.fill_block === 0 || ledgersToFill <= 5 || ledgersToFill % 10 === 0) {
            // recalculate the auction
            const auctionData = await sorobanHelper.loadAuction(
              auction.user_id,
              auction.auction_type
            );
            if (auctionData === undefined) {
              logger.error(`Failed to load auction data for ${stringify(auction)}`);
              continue;
            }
            const fillCalculation = await calculateBlockFillAndPercent(
              filler,
              auction.auction_type,
              auctionData,
              sorobanHelper
            );
            auction.fill_block = fillCalculation.fillBlock + auctionData.block;
            db.setAuctionEntry(auction);
          }

          // TODO: Add other fill conditions like force fill
          if (auction.fill_block <= nextLedger) {
            let submission: AuctionBid = {
              type: BidderSubmissionType.BID,
              filler: filler,
              auctionEntry: auction,
            };
            submissionQueue.addSubmission(submission, 10);
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
