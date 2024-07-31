import { connect } from "amqplib";
import { config } from "dotenv";
import { WORK_QUEUE_KEY } from "./constants.js";
import { logger } from "./utils/logger.js";
config();

async function main() {
  const connection = await connect("amqp://localhost");
  const channel = await connection.createChannel();
  await channel.assertQueue(WORK_QUEUE_KEY, { durable: true });

  logger.info(`Connected to ${WORK_QUEUE_KEY}`);

  setInterval(async () => {
    const message = `Event collected at ${new Date().toISOString()}`;
    channel.sendToQueue(WORK_QUEUE_KEY, Buffer.from(message), {
      persistent: true,
    });
    logger.info(`Event sent to ${WORK_QUEUE_KEY}`);
  }, 1000);
}

main().catch(console.error);
