import { Network } from '@blend-capital/blend-sdk';
import { AuctionHandler } from './auction_handler.js';
import { SorobanHelper } from './utils/soroban_helper.js';
import { AuctioneerDatabase } from './utils/db.js';
import { logger } from './utils/logger.js';
import { deadletterEvent, readEvent } from './utils/messages.js';
import { EventType } from './events.js';

const RPC_URL = process.env.RPC_URL as string;
const PASSPHRASE = process.env.NETWORK_PASSPHRASE as string;
const POOL_ADDRESS = process.env.POOL_ADDRESS as string;
const BACKSTOP_ADDRESS = process.env.BACKSTOP_ADDRESS as string;
const COMET_ID = process.env.COMET_ID as string;
const USDC_ID = process.env.USDC_ID as string;

async function main() {
  const db = AuctioneerDatabase.connect();
  const network: Network = {
    rpc: RPC_URL,
    passphrase: PASSPHRASE,
    opts: {
      allowHttp: true,
    },
  };

  process.on('message', async (message: any) => {
    let appEvent = readEvent(message);
    if (appEvent?.type === EventType.LEDGER) {
      try {
        const timer = Date.now();
        logger.info(`Processing: ${message?.data}`);
        const blendHelper = new SorobanHelper(
          network,
          POOL_ADDRESS,
          BACKSTOP_ADDRESS,
          COMET_ID,
          USDC_ID
        );
        const eventHandler = new AuctionHandler([], db, blendHelper);
        await eventHandler.processEvent(appEvent);
        logger.info(
          `Finished: ${message?.data} in ${Date.now() - timer}ms with delay ${timer - appEvent.timestamp}ms`
        );
      } catch (err) {
        logger.error(`Unexpected error in bidder for ${message?.data}`, err);
        await deadletterEvent(appEvent);
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

  console.log('Bidder listening for events...');
}

main().catch((error) => {
  console.error('Unhandled error in bidder', error);
  process.exit(1);
});
