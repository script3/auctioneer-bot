import { AppEvent, EventType } from './events.js';
import { checkUsersForLiquidations, scanUsers } from './liquidations.js';
import { OracleHistory } from './oracle_history.js';
import { AuctioneerDatabase, UserEntry } from './utils/db.js';
import { logger } from './utils/logger.js';
import { deadletterEvent } from './utils/messages.js';
import { setPrices } from './utils/prices.js';
import { SorobanHelper } from './utils/soroban_helper.js';
import { WorkSubmitter } from './work_submitter.js';

const MAX_RETRIES = 3;
const RETRY_DELAY = 1000;

/**
 * Event handler for processing events.
 */
export class WorkHandler {
  private db: AuctioneerDatabase;
  private submissionQueue: WorkSubmitter;
  private oracleHistory: OracleHistory;
  constructor(
    db: AuctioneerDatabase,
    submissionQueue: WorkSubmitter,
    oracleHistory: OracleHistory
  ) {
    this.db = db;
    this.submissionQueue = submissionQueue;
    this.oracleHistory = oracleHistory;
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
      case EventType.PRICE_UPDATE: {
        await setPrices(this.db);
        break;
      }
      case EventType.ORACLE_SCAN: {
        const soroban_helper = new SorobanHelper();
        const poolOracle = await soroban_helper.loadPoolOracle();
        const priceChanges = this.oracleHistory.getSignificantPriceChanges(poolOracle);
        // @dev: Insert into a set to ensure uniqueness
        let usersToCheck = new Set<UserEntry>();
        for (const assetId of priceChanges.up) {
          const usersWithLiability = this.db.getUserEntriesWithLiability(assetId);
          for (const user of usersWithLiability) {
            usersToCheck.add(user);
          }
        }
        for (const assetId of priceChanges.down) {
          const usersWithCollateral = this.db.getUserEntriesWithCollateral(assetId);
          for (const user of usersWithCollateral) {
            usersToCheck.add(user);
          }
        }
        const liquidations = await checkUsersForLiquidations(
          soroban_helper,
          Array.from(usersToCheck)
        );
        for (const liquidation of liquidations) {
          this.submissionQueue.addSubmission(liquidation, 2);
        }
        break;
      }
      case EventType.LIQ_SCAN: {
        const sorobanHelper = new SorobanHelper();
        const liquidations = await scanUsers(this.db, sorobanHelper);
        for (const liquidation of liquidations) {
          this.submissionQueue.addSubmission(liquidation, 2);
        }
        break;
      }
      default:
        logger.error(`Unhandled event type: ${appEvent.type}`);
        break;
    }
  }
}
