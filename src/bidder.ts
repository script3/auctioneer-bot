import { BidderHandler } from './bidder_handler.js';
import { BidderSubmitter } from './bidder_submitter.js';
import { EventType } from './events.js';
import { AuctioneerDatabase, AuctionType } from './utils/db.js';
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
    if (appEvent) {
      try {
        const timer = Date.now();
        logger.info(`Processing: ${message?.data}`);
        const sorobanHelper = new SorobanHelper();
        const eventHandler = new BidderHandler(db, submissionQueue, sorobanHelper);
        let latestLedger =
          appEvent.type === EventType.LEDGER
            ? appEvent.ledger
            : await sorobanHelper.loadLatestLedger();
        db.setStatusEntry({ name: 'bidder', latest_ledger: latestLedger });
        await eventHandler.processEvent(appEvent);
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
