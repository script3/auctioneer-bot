import { Channel } from "amqplib";
import { AUCTION_QUEUE_KEY } from "./constants.js";
import { BlendHelper } from "./utils/blend_helper.js";
import { AuctioneerDatabase } from "./utils/db.js";
import { logger } from "./utils/logger.js";

/**
 * Event handler for processing events on the work queue.
 */
export class WorkHandler {
  private db: AuctioneerDatabase;
  private blendHelper: BlendHelper;
  private channel: Channel;

  constructor(
    db: AuctioneerDatabase,
    blendHelper: BlendHelper,
    channel: Channel
  ) {
    this.db = db;
    this.blendHelper = blendHelper;
    this.channel = channel;
  }

  /**
   * Process an event from the work queue.
   *
   * This function will return if it successfully processed the event.
   * If the event fails to process, it will throw an error.
   *
   * @param work_event - The event to process
   */
  async processEvent(work_event: string): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 1000));

    if (Math.random() < 0.2) {
      const submissionMsg = `Submission from ${work_event}`;
      this.channel.sendToQueue(AUCTION_QUEUE_KEY, Buffer.from(submissionMsg), {
        persistent: true,
      });
      logger.info(`Sent to ${AUCTION_QUEUE_KEY}`);
    }
  }
}
