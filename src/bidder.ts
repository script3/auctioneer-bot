import { connect, ConsumeMessage } from "amqplib";
import { config } from "dotenv";
import { AUCTION_QUEUE_KEY } from "./constants.js";
import { connectToDb } from "./db.js";
import { logger } from "./logger.js";
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
        try {
          logger.info(
            `Processing: ${AUCTION_QUEUE_KEY} ${msg.content.toString()}`
          );
          await processMessage(msg);
          logger.info(
            `Succesfully processed: ${AUCTION_QUEUE_KEY} ${msg.content.toString()}`
          );
          channel.ack(msg, false);
        } catch (err) {
          logger.error(
            `Error in bidder for ${AUCTION_QUEUE_KEY} ${msg.content.toString()}`,
            err
          );
          channel.nack(msg, false, true);
        }
      }
    },
    {
      // manual acknowledgment mode
      noAck: false,
    }
  );
}

async function processMessage(msg: ConsumeMessage) {
  await new Promise((resolve) => setTimeout(resolve, 500));

  if (Math.random() < 0.2) {
    const db = connectToDb();
    db.run(
      "INSERT INTO transactions (timestamp) VALUES (?)",
      [new Date().toISOString()],
      (err) => {
        if (err) {
          logger.error(`Error inserting transaction`, err);
        } else {
          logger.info(`Submitted transaction to network`);
        }
      }
    );
    db.close();
  }
}

main().catch(console.error);
