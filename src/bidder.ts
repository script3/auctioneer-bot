import { Network } from "@blend-capital/blend-sdk";
import { connect } from "amqplib";
import { config } from "dotenv";
import { AuctionHandler } from "./auction_handler.js";
import { AUCTION_QUEUE_KEY } from "./constants.js";
import { BlendHelper } from "./utils/blend_helper.js";
import { AuctioneerDatabase } from "./utils/db.js";
import { logger } from "./utils/logger.js";

config();

async function main() {
  const connection = await connect("amqp://localhost");
  const channel = await connection.createChannel();
  await channel.assertQueue(AUCTION_QUEUE_KEY);
  logger.info(`Connected to ${AUCTION_QUEUE_KEY}`);

  channel.consume(
    AUCTION_QUEUE_KEY,
    async (msg) => {
      if (msg !== null) {
        let db: AuctioneerDatabase | undefined = undefined;
        try {
          const timer = Date.now();
          logger.info(
            `Processing: ${AUCTION_QUEUE_KEY} ${msg.content.toString()}`
          );
          db = AuctioneerDatabase.connect();
          let network: Network = {
            rpc: "http://localhost:8000/soroban/rpc",
            passphrase: "Test SDF Network ; September 2015",
          };
          const blendHelper = new BlendHelper(network);
          const eventHandler = new AuctionHandler(db, blendHelper);
          await eventHandler.processEvent(msg.content.toString());
          logger.info(
            `Succesfully processed: ${AUCTION_QUEUE_KEY} ${msg.content.toString()} in ${Date.now() - timer}ms`
          );
          channel.ack(msg, false);
        } catch (err) {
          logger.error(
            `Error in bidder for ${AUCTION_QUEUE_KEY} ${msg.content.toString()}`,
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

main().catch(console.error);
