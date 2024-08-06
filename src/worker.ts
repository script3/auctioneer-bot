import { Network } from '@blend-capital/blend-sdk';
import { connect } from 'amqplib';
import { config } from 'dotenv';
import { AUCTION_QUEUE_KEY, WORK_QUEUE_KEY } from './constants.js';
import { AppEvent } from './events.js';
import { BlendHelper } from './utils/blend_helper.js';
import { AuctioneerDatabase } from './utils/db.js';
import { parse } from './utils/json.js';
import { logger } from './utils/logger.js';
import { WorkHandler } from './work_handler.js';

config();
const RPC_URL = process.env.RPC_URL as string;
const PASSPHRASE = process.env.NETWORK_PASSPHRASE as string;
const POOL_ADDRESS = process.env.POOL_ADDRESS as string;
const BACKSTOP_ADDRESS = process.env.BACKSTOP_ADDRESS as string;

async function main() {
  const connection = await connect('amqp://localhost');
  const channel = await connection.createChannel();
  await channel.assertQueue(WORK_QUEUE_KEY, { durable: true });
  await channel.assertQueue(AUCTION_QUEUE_KEY, { durable: true });

  logger.info(`Connected to ${WORK_QUEUE_KEY} and ${AUCTION_QUEUE_KEY}`);
  channel.consume(
    WORK_QUEUE_KEY,
    async (msg) => {
      if (msg !== null) {
        let db: AuctioneerDatabase | undefined = undefined;
        try {
          const timer = Date.now();
          const messageContent = msg.content.toString();
          logger.info(`Processing: ${WORK_QUEUE_KEY} ${messageContent}`);
          db = AuctioneerDatabase.connect();
          const network: Network = {
            rpc: RPC_URL,
            passphrase: PASSPHRASE,
            opts: {
              allowHttp: true,
            },
          };
          const blendHelper = new BlendHelper(network, POOL_ADDRESS, BACKSTOP_ADDRESS);
          const eventHandler = new WorkHandler(db, blendHelper, channel);
          const appEvent = parse<AppEvent>(messageContent);
          await eventHandler.processEvent(appEvent);
          logger.info(
            `Succesfully processed: ${WORK_QUEUE_KEY} ${messageContent} in ${Date.now() - timer}ms`
          );
          channel.ack(msg, false);
        } catch (err) {
          logger.error(`Error in worker for ${WORK_QUEUE_KEY} ${msg.content.toString()}`, err);
          channel.nack(msg, false, true);
        } finally {
          if (db) {
            db.close();
          }
        }
      }
    },
    {
      // manual acknowledgment mode
      noAck: false,
    }
  );
}

main().catch(console.error);
