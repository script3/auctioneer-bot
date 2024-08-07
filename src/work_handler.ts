import { AppEvent, EventType } from './events.js';
import { BlendHelper } from './utils/blend_helper.js';
import { AuctioneerDatabase } from './utils/db.js';
import { stringify } from './utils/json.js';
import { logger } from './utils/logger.js';
import { deadletterEvent } from './utils/messages.js';

const MAX_RETRIES = 3;
const RETRY_DELAY = 1000;

/**
 * Event handler for processing events.
 */
export class WorkHandler {
  private db: AuctioneerDatabase;
  private blendHelper: BlendHelper;

  constructor(db: AuctioneerDatabase, blendHelper: BlendHelper) {
    this.db = db;
    this.blendHelper = blendHelper;
  }

  /**
   * Process an app event with retries. If the event cannot be processed, it
   * is persisted to the dead letter queue.
   *
   * @param appEvent - The event to process
   * @returns True if the event was successfully processed, false otherwise.
   */
  async processEventWithRetryAndDeadletter(appEvent: AppEvent): Promise<boolean> {
    let retries = 0;
    while (true) {
      try {
        await this.processEvent(appEvent);
        logger.info(`Successfully processed event.`);
        return true;
      } catch (error) {
        retries++;
        if (retries >= MAX_RETRIES) {
          await deadletterEvent(appEvent);
          return false;
        }
        logger.warn(`Error processing event. Error: ${error}`);
        logger.warn(
          `Retry ${retries + 1}/${MAX_RETRIES}. Waiting ${RETRY_DELAY}ms before next attempt.`
        );
        // Both of these logs above exist, and are the last things logged by timestamp
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
      }
    }
  }

  /**
   * Process an event.
   *
   * This function will return if it successfully processed the event.
   * If the event fails to process, it will throw an error.
   *
   * @param appEvent - The event to process
   */
  async processEvent(appEvent: AppEvent): Promise<void> {
    switch (appEvent.type) {
      case EventType.PRICE_UPDATE:
        let test = this.db.getStatusEntry('collector');
        logger.info(`From worker: ${stringify(test)}`);
        throw new Error('Test the deadletter queue');
      default:
        logger.error(`Unhandled event type: ${appEvent.type}`);
        break;
    }
  }
}
