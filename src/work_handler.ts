import { PoolEventType } from '@blend-capital/blend-sdk';
import { Channel } from 'amqplib';
import { AppEvent, EventType, PoolEventEvent } from './events.js';
import { BlendHelper } from './utils/blend_helper.js';
import { AuctioneerDatabase, UserEntry } from './utils/db.js';
import { logger } from './utils/logger.js';

/**
 * Event handler for processing events on the work queue.
 */
export class WorkHandler {
  private db: AuctioneerDatabase;
  private blendHelper: BlendHelper;
  private channel: Channel;

  constructor(db: AuctioneerDatabase, blendHelper: BlendHelper, channel: Channel) {
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
   * @param appEvent - The event to process
   */
  async processEvent(appEvent: AppEvent): Promise<void> {
    switch (appEvent.type) {
      case EventType.POOL_EVENT:
        await this.handlePoolEvent(appEvent);
        break;
      default:
        logger.error(`Unhandled event type: ${appEvent.type}`);
        break;
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
        // TODO: Optimize loading calls to avoid loading all pool data
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
          this.db.setUserEntry(new_entry);
        } else {
          // user does not have liabilities, remove db entry if it exists
          this.db.deleteUserEntry(poolEvent.event.from);
        }
      }
    }
  }
}
