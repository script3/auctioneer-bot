import { BlendHelper } from "./utils/blend_helper.js";
import { AuctioneerDatabase } from "./utils/db.js";
import { logger } from "./utils/logger.js";

/**
 * Event handler for processing events on the auction queue.
 */
export class AuctionHandler {
  private db: AuctioneerDatabase;
  private blendHelper: BlendHelper;

  constructor(db: AuctioneerDatabase, blendHelper: BlendHelper) {
    this.db = db;
    this.blendHelper = blendHelper;
  }

  /**
   * Process an event from the auction queue.
   *
   * This function will return if it successfully processed the event.
   * If the event fails to process, it will throw an error.
   *
   * @param auction_event - The event to process
   */
  async processEvent(auction_event: string): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 500));

    if (Math.random() < 0.2) {
      this.db.insertTransaction(new Date().toISOString());
      logger.info(
        `Submitted transaction to network for event ${auction_event}`
      );
    }
  }
}
