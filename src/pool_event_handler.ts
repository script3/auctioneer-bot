import { PoolEventType } from '@blend-capital/blend-sdk';
import { ChildProcess } from 'child_process';
import { EventType, PoolEventEvent } from './events.js';
import { canFillerBid } from './filler.js';
import { updateUser } from './user.js';
import { APP_CONFIG } from './utils/config.js';
import { AuctioneerDatabase, AuctionEntry, AuctionType } from './utils/db.js';
import { stringify } from './utils/json.js';
import { logger } from './utils/logger.js';
import { deadletterEvent, sendEvent } from './utils/messages.js';
import { sendNotification } from './utils/notifier.js';
import { SorobanHelper } from './utils/soroban_helper.js';
import { WorkSubmission } from './work_submitter.js';
const MAX_RETRIES = 2;
const RETRY_DELAY = 200;

/**
 * Event handler for processing events on the work queue.
 */
export class PoolEventHandler {
  private db: AuctioneerDatabase;
  private sorobanHelper: SorobanHelper;
  private worker: ChildProcess;

  constructor(db: AuctioneerDatabase, sorobanHelper: SorobanHelper, worker: ChildProcess) {
    this.db = db;
    this.sorobanHelper = sorobanHelper;
    this.worker = worker;
  }

  /**
   * Process a pool event from with retries. If the event cannot be processed, it
   * is persisted to the dead letter queue.
   *
   * @param appEvent - The event to process
   */
  async processEventWithRetryAndDeadLetter(
    poolEvent: PoolEventEvent
  ): Promise<void | WorkSubmission> {
    let retries = 0;
    while (true) {
      try {
        await this.handlePoolEvent(poolEvent);
        logger.info(`Successfully processed event. ${poolEvent.event.id}`);
        return;
      } catch (error: any) {
        retries++;
        if (retries >= MAX_RETRIES) {
          try {
            await deadletterEvent(poolEvent);
          } catch (error: any) {
            logger.error(`Error sending event to dead letter queue.`, error);
          }
          return;
        }
        logger.warn(`Error processing event. ${poolEvent.event.id}.`, error);
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
    const poolId = APP_CONFIG.pools.find((pool) => pool === poolEvent.event.contractId);
    if (!poolId) {
      logger.error(`Received event from an unsupported pool: ${stringify(poolEvent.event)}`);
      return;
    }

    const pool = await this.sorobanHelper.loadPool(poolId);
    switch (poolEvent.event.eventType) {
      case PoolEventType.SupplyCollateral:
      case PoolEventType.WithdrawCollateral:
      case PoolEventType.Borrow:
      case PoolEventType.FlashLoan:
      case PoolEventType.Repay: {
        // update the user in the db
        const { estimate: userPositionsEstimate, user } =
          await this.sorobanHelper.loadUserPositionEstimate(poolId, poolEvent.event.from);
        updateUser(this.db, pool, user, userPositionsEstimate, poolEvent.event.ledger);
        break;
      }

      case PoolEventType.NewAuction: {
        // check if the auction should be bid on by an auctioneer
        let fillerFound = false;
        for (const filler of APP_CONFIG.fillers) {
          // check if filler should try and bid on the auction
          if (!canFillerBid(filler, poolId, poolEvent.event.auctionData)) {
            continue;
          }
          let auctionEntry: AuctionEntry = {
            pool_id: poolId,
            user_id: poolEvent.event.user,
            auction_type: poolEvent.event.auctionType,
            filler: filler.keypair.publicKey(),
            start_block: poolEvent.event.auctionData.block,
            fill_block: 0,
            updated: poolEvent.event.ledger,
          };
          this.db.setAuctionEntry(auctionEntry);

          const logMessage =
            `New auction\n` +
            `Type: ${AuctionType[poolEvent.event.auctionType]}\n` +
            `Filler: ${filler.name}\n` +
            `Pool: ${poolId}\n` +
            `User: ${poolEvent.event.user}\n` +
            `Auction Data: ${stringify(poolEvent.event.auctionData, 2)}\n`;
          await sendNotification(logMessage);
          logger.info(logMessage);
          fillerFound = true;
          break;
        }
        if (!fillerFound) {
          const logMessage =
            `Auction Ignored\n` +
            `Type: ${AuctionType[poolEvent.event.auctionType]}\n` +
            `Pool: ${poolId}\n` +
            `User: ${poolEvent.event.user}\n` +
            `Auction Data: ${stringify(poolEvent.event.auctionData, 2)}\n`;
          await sendNotification(logMessage);
          logger.info(logMessage);
        }
        break;
      }
      case PoolEventType.DeleteLiquidationAuction: {
        // user position is now healthy and user deleted their liquidation auction
        let runResult = this.db.deleteAuctionEntry(
          poolId,
          poolEvent.event.user,
          AuctionType.Liquidation
        );
        if (runResult.changes !== 0) {
          const logMessage =
            `Liquidation Auction Deleted\n` +
            `Pool: ${poolId}\n` +
            `User: ${poolEvent.event.user}\n`;
          await sendNotification(logMessage);
          logger.info(logMessage);
        }
        break;
      }
      case PoolEventType.FillAuction: {
        const fillerAddress = poolEvent.event.filler;
        const logMessage =
          `Auction Fill Event\n` +
          `Type ${AuctionType[poolEvent.event.auctionType]}\n` +
          `Filler: ${fillerAddress}\n` +
          `Pool: ${poolId}\n` +
          `User: ${poolEvent.event.user}\n` +
          `Fill Percent: ${poolEvent.event.fillAmount}\n` +
          `Tx Hash: ${poolEvent.event.txHash}\n`;
        await sendNotification(logMessage);
        logger.info(logMessage);
        if (poolEvent.event.fillAmount === BigInt(100)) {
          // auction was fully filled, remove from ongoing auctions
          let runResult = this.db.deleteAuctionEntry(
            poolId,
            poolEvent.event.user,
            poolEvent.event.auctionType
          );
          if (runResult.changes !== 0) {
            logger.info(
              `Auction Deleted\n` +
                `Type: ${AuctionType[poolEvent.event.auctionType]}\n` +
                `Pool: ${poolId}\n` +
                `User: ${poolEvent.event.user}`
            );
          }
        }
        if (poolEvent.event.auctionType === AuctionType.Liquidation) {
          const { estimate: userPositionsEstimate, user } =
            await this.sorobanHelper.loadUserPositionEstimate(poolId, poolEvent.event.user);
          updateUser(this.db, pool, user, userPositionsEstimate, poolEvent.event.ledger);
          const { estimate: fillerPositionsEstimate, user: filler } =
            await this.sorobanHelper.loadUserPositionEstimate(poolId, fillerAddress);
          updateUser(this.db, pool, filler, fillerPositionsEstimate, poolEvent.event.ledger);
        } else if (poolEvent.event.auctionType === AuctionType.BadDebt) {
          const { estimate: fillerPositionsEstimate, user: filler } =
            await this.sorobanHelper.loadUserPositionEstimate(poolId, fillerAddress);
          updateUser(this.db, pool, filler, fillerPositionsEstimate, poolEvent.event.ledger);
          sendEvent(this.worker, {
            type: EventType.CHECK_USER,
            timestamp: Date.now(),
            poolId,
            userId: APP_CONFIG.backstopAddress,
          });
        }
        break;
      }

      case PoolEventType.BadDebt: {
        // user has transferred bad debt to the backstop address
        const { estimate: userPositionsEstimate, user } =
          await this.sorobanHelper.loadUserPositionEstimate(poolId, poolEvent.event.user);
        updateUser(this.db, pool, user, userPositionsEstimate, poolEvent.event.ledger);
        sendEvent(this.worker, {
          type: EventType.CHECK_USER,
          timestamp: Date.now(),
          poolId,
          userId: APP_CONFIG.backstopAddress,
        });
        break;
      }
      case PoolEventType.DeleteAuction: {
        const user = poolEvent.event.user;
        const auctionType = poolEvent.event.auctionType;
        let runResult = this.db.deleteAuctionEntry(poolId, user, auctionType);
        if (runResult.changes !== 0) {
          const logMessage =
            `Stale Auction Deleted\n` +
            `Type: ${AuctionType[auctionType]}\n` +
            `Pool: ${poolId}\n` +
            `User: ${user}`;
          await sendNotification(logMessage);
          logger.info(logMessage);
        }
      }
      default: {
        logger.error(`Unhandled event type: ${poolEvent.event.eventType}`);
        break;
      }
    }
  }
}
