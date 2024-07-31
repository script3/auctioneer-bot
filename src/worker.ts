import { Network } from "@blend-capital/blend-sdk";
import { Channel, connect, ConsumeMessage } from "amqplib";
import { config } from "dotenv";
import { AUCTION_QUEUE_KEY, WORK_QUEUE_KEY } from "./constants.js";
import { BlendHelper } from "./utils/blend_helper.js";
import { AuctioneerDatabase } from "./utils/db.js";
import { logger } from "./utils/logger.js";
import { WorkHandler } from "./work_handler.js";

config();

async function main() {
  const connection = await connect("amqp://localhost");
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
          logger.info(
            `Processing: ${WORK_QUEUE_KEY} ${msg.content.toString()}`
          );
          db = AuctioneerDatabase.connect();
          let network: Network = {
            rpc: "http://localhost:8000/soroban/rpc",
            passphrase: "Test SDF Network ; September 2015",
          };
          const blendHelper = new BlendHelper(network);
          const eventHandler = new WorkHandler(db, blendHelper, channel);
          await eventHandler.processEvent(msg.content.toString());
          logger.info(
            `Succesfully processed: ${WORK_QUEUE_KEY} ${msg.content.toString()} in ${Date.now() - timer}ms`
          );
          channel.ack(msg, false);
        } catch (err) {
          logger.error(
            `Error in worker for ${WORK_QUEUE_KEY} ${msg.content.toString()}`,
            err
          );
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

async function processMessage(msg: ConsumeMessage, channel: Channel) {
  await new Promise((resolve) => setTimeout(resolve, 1000));

  if (Math.random() < 0.2) {
    const submissionMsg = `Submission from ${msg.content.toString()}`;
    channel.sendToQueue(AUCTION_QUEUE_KEY, Buffer.from(submissionMsg), {
      persistent: true,
    });
    logger.info(`Sent to ${AUCTION_QUEUE_KEY}`);
  }
}

main().catch(console.error);
