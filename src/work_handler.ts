import { AppEvent, EventType } from './events.js';
import { scanUsers } from './liquidation_creator.js';
import { AuctioneerDatabase } from './utils/db.js';
import { logger } from './utils/logger.js';
import { deadletterEvent } from './utils/messages.js';
import { setPrices } from './utils/prices.js';
import { SorobanHelper } from './utils/soroban_helper.js';
import { WorkSubmissionType, WorkSubmitter } from './work_submitter.js';
import { APP_CONFIG } from './utils/config.js';

const MAX_RETRIES = 3;
const RETRY_DELAY = 1000;

/**
 * Event handler for processing events.
 */
export class WorkHandler {
  private db: AuctioneerDatabase;
  private submissionQueue: WorkSubmitter;
  constructor(db: AuctioneerDatabase, submissionQueue: WorkSubmitter) {
    this.db = db;
    this.submissionQueue = submissionQueue;
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
        await setPrices(this.db);
        break;
      case EventType.LIQ_SCAN:
        const sorobanHelper = new SorobanHelper();
        const liquidations = await scanUsers(this.db, sorobanHelper);
        liquidations.forEach((liquidation) => {
          this.submissionQueue.addSubmission(liquidation, 2);
        });
        break;
      default:
        logger.error(`Unhandled event type: ${appEvent.type}`);
        break;
    }
  }
}
