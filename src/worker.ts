import { Network } from '@blend-capital/blend-sdk';
import { BlendHelper } from './utils/blend_helper.js';
import { AuctioneerDatabase } from './utils/db.js';
import { logger } from './utils/logger.js';
import { deadletterEvent, readEvent } from './utils/messages.js';
import { WorkHandler } from './work_handler.js';

const RPC_URL = process.env.RPC_URL as string;
const PASSPHRASE = process.env.NETWORK_PASSPHRASE as string;
const POOL_ADDRESS = process.env.POOL_ADDRESS as string;
const BACKSTOP_ADDRESS = process.env.BACKSTOP_ADDRESS as string;

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
    if (appEvent) {
      try {
        const timer = Date.now();
        logger.info(`Processing: ${message?.data}`);
        const blendHelper = new BlendHelper(network, POOL_ADDRESS, BACKSTOP_ADDRESS);
        const eventHandler = new WorkHandler(db, blendHelper);
        await eventHandler.processEventWithRetryAndDeadletter(appEvent);
        logger.info(
          `Finished: ${message?.data} in ${Date.now() - timer}ms with delay ${timer - appEvent.timestamp}ms`
        );
      } catch (err) {
        logger.error(`Unexpected error in worker for ${message?.data}`, err);
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
    console.error('Worker errored.', error);
    db.close();
    process.exit(1);
  });

  console.log('Worker listening for events...');
}

main().catch((error) => {
  console.error('Unhandled error in worker', error);
  process.exit(1);
});
