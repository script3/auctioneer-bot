import { PoolEventType } from '@blend-capital/blend-sdk';
import { canFillerBid } from './auction.js';
import { EventType, PoolEventEvent } from './events.js';
import { updateUser } from './user.js';
import { APP_CONFIG } from './utils/config.js';
import { AuctioneerDatabase, AuctionEntry, AuctionType } from './utils/db.js';
import { stringify } from './utils/json.js';
import { logger } from './utils/logger.js';
import { deadletterEvent, sendEvent } from './utils/messages.js';
import { sendSlackNotification } from './utils/slack_notifier.js';
import { SorobanHelper } from './utils/soroban_helper.js';
import { WorkSubmission } from './work_submitter.js';
import { ChildProcess } from 'child_process';
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
    const pool = await this.sorobanHelper.loadPool();
    switch (poolEvent.event.eventType) {
      case PoolEventType.SupplyCollateral:
      case PoolEventType.WithdrawCollateral:
      case PoolEventType.Borrow:
      case PoolEventType.Repay: {
        // update the user in the db
        const { estimate: userPositionsEstimate, user } =
          await this.sorobanHelper.loadUserPositionEstimate(poolEvent.event.from);
        updateUser(this.db, pool, user, userPositionsEstimate, poolEvent.event.ledger);
        break;
      }
      case PoolEventType.NewLiquidationAuction:
      case PoolEventType.NewAuction: {
        let auction_type =
          poolEvent.event.eventType === PoolEventType.NewLiquidationAuction
            ? AuctionType.Liquidation
            : poolEvent.event.auctionType;
        let user =
          poolEvent.event.eventType === PoolEventType.NewLiquidationAuction
            ? poolEvent.event.user
            : APP_CONFIG.backstopAddress;
        // check if the auction should be bid on by an auctioneer
        let fillerFound = false;
        for (const filler of APP_CONFIG.fillers) {
          // check if filler should try and bid on the auction
          if (!canFillerBid(filler, poolEvent.event.auctionData)) {
            continue;
          }
          let auctionEntry: AuctionEntry = {
            user_id: user,
            auction_type: auction_type,
            filler: filler.keypair.publicKey(),
            start_block: poolEvent.event.auctionData.block,
            fill_block: 0,
            updated: poolEvent.event.ledger,
          };
          this.db.setAuctionEntry(auctionEntry);

          const logMessage = `New auction\nType: ${AuctionType[auction_type]}\nFiller: ${filler.name}\nUser: ${user}\nAuction Data: ${stringify(poolEvent.event.auctionData, 2)}\n`;
          await sendSlackNotification(logMessage);
          logger.info(logMessage);
          fillerFound = true;
          break;
        }
        if (!fillerFound) {
          const logMessage = `Auction Ignored\n Type: ${AuctionType[auction_type]}\nUser: ${user}\nAuction Data: ${stringify(poolEvent.event.auctionData, 2)}\n`;
          await sendSlackNotification(logMessage);
          logger.info(logMessage);
        }
        break;
      }
      case PoolEventType.DeleteLiquidationAuction: {
        // user position is now healthy and user deleted their liquidation auction
        let runResult = this.db.deleteAuctionEntry(poolEvent.event.user, AuctionType.Liquidation);
        if (runResult.changes !== 0) {
          const logMessage = `Liquidation Auction Deleted\nUser: ${poolEvent.event.user}\n`;
          await sendSlackNotification(logMessage);
          logger.info(logMessage);
        }
        break;
      }
      case PoolEventType.FillAuction: {
        const logMessage = `Auction Fill Event\nType ${AuctionType[poolEvent.event.auctionType]}\nFiller: ${poolEvent.event.from}\nUser: ${poolEvent.event.user}\nFill Percent: ${poolEvent.event.fillAmount}\nTx Hash: ${poolEvent.event.txHash}\n`;
        await sendSlackNotification(logMessage);
        if (poolEvent.event.fillAmount === BigInt(100)) {
          // auction was fully filled, remove from ongoing auctions
          let runResult = this.db.deleteAuctionEntry(
            poolEvent.event.user,
            poolEvent.event.auctionType
          );
          if (runResult.changes !== 0) {
            logger.info(logMessage);
          }
          if (poolEvent.event.auctionType === AuctionType.Liquidation) {
            const { estimate: userPositionsEstimate, user } =
              await this.sorobanHelper.loadUserPositionEstimate(poolEvent.event.user);
            updateUser(this.db, pool, user, userPositionsEstimate, poolEvent.event.ledger);
          } else if (poolEvent.event.auctionType === AuctionType.BadDebt) {
            sendEvent(this.worker, {
              type: EventType.CHECK_USER,
              timestamp: Date.now(),
              userId: APP_CONFIG.backstopAddress,
            });
          }
        }
        break;
      }

      case PoolEventType.BadDebt: {
        // user has transferred bad debt to the backstop address
        const { estimate: userPositionsEstimate, user } =
          await this.sorobanHelper.loadUserPositionEstimate(poolEvent.event.user);
        updateUser(this.db, pool, user, userPositionsEstimate, poolEvent.event.ledger);
        sendEvent(this.worker, {
          type: EventType.CHECK_USER,
          timestamp: Date.now(),
          userId: APP_CONFIG.backstopAddress,
        });
        break;
      }
      default: {
        logger.error(`Unhandled event type: ${poolEvent.event.eventType}`);
        break;
      }
    }
  }
}
