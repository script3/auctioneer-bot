import { AppEvent, EventType } from './events.js';
import { checkUsersForLiquidationsAndBadDebt, scanUsers } from './liquidations.js';
import { OracleHistory } from './oracle_history.js';
import { updateUser } from './user.js';
import { APP_CONFIG } from './utils/config.js';
import { AuctioneerDatabase } from './utils/db.js';
import { logger } from './utils/logger.js';
import { deadletterEvent } from './utils/messages.js';
import { setPrices } from './utils/prices.js';
import { sendNotification, NotificationLevel } from './utils/notifier.js';
import { SorobanHelper } from './utils/soroban_helper.js';
import { WorkSubmitter } from './work_submitter.js';
import { checkPoolForInterestAuction } from './interest.js';

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
        logger.warn(`Error processing ${appEvent.type}.`, error);
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
        for (const poolConfig of APP_CONFIG.pools) {
          let usersToCheck = new Set<string>();
          const poolOracle = await this.sorobanHelper.loadPoolOracle(poolConfig.poolAddress);
          const priceChanges = this.oracleHistory.getSignificantPriceChanges(poolOracle);
          // @dev: Insert into a set to ensure uniqueness
          for (const assetId of priceChanges.up) {
            const usersWithLiability = this.db.getUserEntriesWithLiability(
              poolConfig.poolAddress,
              assetId
            );
            for (const user of usersWithLiability) {
              usersToCheck.add(user.user_id);
            }
          }
          for (const assetId of priceChanges.down) {
            const usersWithCollateral = this.db.getUserEntriesWithCollateral(
              poolConfig.poolAddress,
              assetId
            );
            for (const user of usersWithCollateral) {
              usersToCheck.add(user.user_id);
            }
          }
          const liquidations = await checkUsersForLiquidationsAndBadDebt(
            this.db,
            this.sorobanHelper,
            poolConfig.poolAddress,
            Array.from(usersToCheck)
          );
          for (const liquidation of liquidations) {
            this.submissionQueue.addSubmission(liquidation, 3);
          }
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
        for (const poolConfig of APP_CONFIG.pools) {
          try {
            const pool = await this.sorobanHelper.loadPool(poolConfig.poolAddress);
            const oldUsers = this.db.getUserEntriesUpdatedBefore(
              poolConfig.poolAddress,
              appEvent.cutoff
            );

            for (const user of oldUsers) {
              try {
                // Send alert and log if user has not been updated in 1 month
                if (user.updated < Math.max(appEvent.cutoff - 17280 * 14, 0)) {
                  const logMessage =
                    `Warning user has not been updated since ledger ${appEvent.cutoff}\n` +
                    `Pool: ${poolConfig.poolAddress}\n` +
                    `User: ${user.user_id}`;
                  logger.error(logMessage);
                  await sendNotification(logMessage, NotificationLevel.MED);
                }

                const { estimate: poolUserEstimate, user: poolUser } =
                  await this.sorobanHelper.loadUserPositionEstimate(
                    poolConfig.poolAddress,
                    user.user_id
                  );
                updateUser(this.db, pool, poolUser, poolUserEstimate);
              } catch (e) {
                logger.error(`Error refreshing user ${user.user_id} in pool ${user.pool_id}: ${e}`);
              }
            }
          } catch (e) {
            logger.error(`Error refreshing users in pool ${poolConfig.poolAddress}: ${e}`);
            continue;
          }
        }

        break;
      }
      case EventType.CHECK_USER: {
        const submissions = await checkUsersForLiquidationsAndBadDebt(
          this.db,
          this.sorobanHelper,
          appEvent.poolId,
          [appEvent.userId]
        );
        for (const submission of submissions) {
          this.submissionQueue.addSubmission(submission, 3);
        }
        break;
      }
      case EventType.CHECK_INTEREST: {
        for (const poolConfig of APP_CONFIG.pools) {
          const submission = await checkPoolForInterestAuction(this.sorobanHelper, poolConfig);
          if (submission) {
            this.submissionQueue.addSubmission(submission, 2);
            // only submit one interest auction at a time
            return;
          }
        }
        break;
      }
      default:
        logger.error(`Unhandled event type: ${appEvent.type}`);
        break;
    }
  }
}
