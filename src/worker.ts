import { Channel, connect, ConsumeMessage } from "amqplib";
import { config } from "dotenv";
import { AUCTION_QUEUE_KEY, WORK_QUEUE_KEY } from "./constants.js";
import { logger } from "./logger.js";
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
        try {
          logger.info(
            `Processing: ${WORK_QUEUE_KEY} ${msg.content.toString()}`
          );
          await processMessage(msg, channel);
          logger.info(
            `Succesfully processed: ${WORK_QUEUE_KEY} ${msg.content.toString()}`
          );
          channel.ack(msg, false);
        } catch (err) {
          logger.error(`Error in worker`, err);
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
