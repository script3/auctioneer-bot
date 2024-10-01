import { AppEvent, EventType } from './events.js';
import { checkUsersForLiquidationsAndBadDebt, scanUsers } from './liquidations.js';
import { OracleHistory } from './oracle_history.js';
import { updateUser } from './user.js';
import { AuctioneerDatabase } from './utils/db.js';
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
  private sorobanHelper: SorobanHelper;
  constructor(
    db: AuctioneerDatabase,
    submissionQueue: WorkSubmitter,
    oracleHistory: OracleHistory,
    sorobanHelper: SorobanHelper
  ) {
    this.db = db;
    this.submissionQueue = submissionQueue;
    this.oracleHistory = oracleHistory;
    this.sorobanHelper = sorobanHelper;
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
        const poolOracle = await this.sorobanHelper.loadPoolOracle();
        const priceChanges = this.oracleHistory.getSignificantPriceChanges(poolOracle);
        // @dev: Insert into a set to ensure uniqueness
        let usersToCheck = new Set<string>();
        for (const assetId of priceChanges.up) {
          const usersWithLiability = this.db.getUserEntriesWithLiability(assetId);
          for (const user of usersWithLiability) {
            usersToCheck.add(user.user_id);
          }
        }
        for (const assetId of priceChanges.down) {
          const usersWithCollateral = this.db.getUserEntriesWithCollateral(assetId);
          for (const user of usersWithCollateral) {
            usersToCheck.add(user.user_id);
          }
        }
        const liquidations = await checkUsersForLiquidationsAndBadDebt(
          this.db,
          this.sorobanHelper,
          Array.from(usersToCheck)
        );
        for (const liquidation of liquidations) {
          this.submissionQueue.addSubmission(liquidation, 3);
        }
        break;
      }
      case EventType.LIQ_SCAN: {
        const liquidations = await scanUsers(this.db, this.sorobanHelper);
        for (const liquidation of liquidations) {
          this.submissionQueue.addSubmission(liquidation, 3);
        }
        break;
      }
      case EventType.USER_REFRESH: {
        const oldUsers = this.db.getUserEntriesUpdatedBefore(appEvent.cutoff);
        if (oldUsers.length === 0) {
          return;
        }
        const pool = await this.sorobanHelper.loadPool();
        for (const user of oldUsers) {
          const { estimate: poolUserEstimate, user: poolUser } =
            await this.sorobanHelper.loadUserPositionEstimate(user.user_id);
          updateUser(this.db, pool, poolUser, poolUserEstimate);
        }
        break;
      }
      case EventType.CHECK_USER: {
        const submissions = await checkUsersForLiquidationsAndBadDebt(this.db, this.sorobanHelper, [
          appEvent.userId,
        ]);
        for (const submission of submissions) {
          this.submissionQueue.addSubmission(submission, 3);
        }
      }
      default:
        logger.error(`Unhandled event type: ${appEvent.type}`);
        break;
    }
  }
}
