import { PoolEventType } from '@blend-capital/blend-sdk';
import { PoolEventEvent } from './events.js';
import { BlendHelper } from './utils/blend_helper.js';
import { AuctioneerDatabase, UserEntry } from './utils/db.js';
import { stringify } from './utils/json.js';
import { logger } from './utils/logger.js';
import { deadletterEvent } from './utils/messages.js';

const MAX_RETRIES = 2;
const RETRY_DELAY = 200;

/**
 * Event handler for processing events on the work queue.
 */
export class PoolEventHandler {
  private db: AuctioneerDatabase;
  private blendHelper: BlendHelper;

  constructor(db: AuctioneerDatabase, blendHelper: BlendHelper) {
    this.db = db;
    this.blendHelper = blendHelper;
  }

  /**
   * Process a pool event from with retries. If the event cannot be processed, it
   * is persisted to the dead letter queue.
   *
   * @param appEvent - The event to process
   */
  async processEventWithRetryAndDeadLetter(poolEvent: PoolEventEvent): Promise<void> {
    let retries = 0;
    while (true) {
      try {
        await this.handlePoolEvent(poolEvent);
        logger.info(`Successfully processed event. ${poolEvent.event.id}`);
        return;
      } catch (error) {
        retries++;
        if (retries >= MAX_RETRIES) {
          try {
            await deadletterEvent(poolEvent);
          } catch (error) {
            logger.error(`Error sending event to dead letter queue. Error: ${error}`);
          }
          return;
        }
        logger.warn(`Error processing event. ${poolEvent.event.id} Error: ${error}`);
        logger.warn(
          `Retry ${retries + 1}/${MAX_RETRIES}. Waiting ${RETRY_DELAY}ms before next attempt.`
        );
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
      }
    }
  }

  /**
   * Handle a pool event.
   * @param poolEvent - The pool event to handle
   */
  async handlePoolEvent(poolEvent: PoolEventEvent): Promise<void> {
    switch (poolEvent.event.eventType) {
      case PoolEventType.SupplyCollateral:
      case PoolEventType.WithdrawCollateral:
      case PoolEventType.Borrow:
      case PoolEventType.Repay: {
        // update the user in the db
        const pool = await this.blendHelper.loadPool();
        const user = await this.blendHelper.loadUser(pool, poolEvent.event.from);
        if (user.positions.liabilities.size !== 0) {
          // user has liabilities, update db entry
          let collateralAddress = new Map<string, bigint>();
          for (let [assetIndex, amount] of user.positions.collateral) {
            const asset = pool.config.reserveList[assetIndex];
            collateralAddress.set(asset, amount);
          }
          let liabilitiesAddress = new Map<string, bigint>();
          for (let [assetIndex, amount] of user.positions.liabilities) {
            const asset = pool.config.reserveList[assetIndex];
            liabilitiesAddress.set(asset, amount);
          }
          const new_entry: UserEntry = {
            user_id: poolEvent.event.from,
            health_factor:
              user.positionEstimates.totalEffectiveCollateral /
              user.positionEstimates.totalBorrowed,
            collateral: collateralAddress,
            liabilities: liabilitiesAddress,
            updated: pool.latestLedger,
          };
          let result = this.db.setUserEntry(new_entry);
          logger.info(`Updated user entry: ${stringify(result)}`);
        } else {
          // user does not have liabilities, remove db entry if it exists
          this.db.deleteUserEntry(poolEvent.event.from);
        }
      }
    }
  }
}
