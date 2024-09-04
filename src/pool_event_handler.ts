import { PoolEventType } from '@blend-capital/blend-sdk';
import { canFillerBid } from './auction.js';
import { PoolEventEvent } from './events.js';
import { updateUser } from './user.js';
import { APP_CONFIG } from './utils/config.js';
import { AuctioneerDatabase, AuctionEntry, AuctionType, UserEntry } from './utils/db.js';
import { logger } from './utils/logger.js';
import { deadletterEvent } from './utils/messages.js';
import { SorobanHelper } from './utils/soroban_helper.js';

const MAX_RETRIES = 2;
const RETRY_DELAY = 200;

/**
 * Event handler for processing events on the work queue.
 */
export class PoolEventHandler {
  private db: AuctioneerDatabase;
  private sorobanHelper: SorobanHelper;

  constructor(db: AuctioneerDatabase, sorobanHelper: SorobanHelper) {
    this.db = db;
    this.sorobanHelper = sorobanHelper;
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
      case PoolEventType.NewAuction: {
        // check if the auction should be bid on by an auctioneer
        let fillerFound = false;
        for (const filler of APP_CONFIG.fillers) {
          // check if filler should try and bid on the auction
          if (!canFillerBid(filler, poolEvent.event.auctionData)) {
            continue;
          }
          let auctionEntry: AuctionEntry = {
            user_id: APP_CONFIG.backstopAddress,
            auction_type: poolEvent.event.auctionType,
            filler: filler.keypair.publicKey(),
            start_block: poolEvent.event.auctionData.block,
            fill_block: 0,
            updated: poolEvent.event.ledger,
          };
          this.db.setAuctionEntry(auctionEntry);
          logger.info(
            `Added auction of type ${poolEvent.event.auctionType} to ongoing for filler: ${filler.name}`
          );
          fillerFound = true;
          break;
        }
        if (!fillerFound) {
          logger.info(
            `No filler found for auction with type ${poolEvent.event.auctionType}. Ignoring.`
          );
        }
        break;
      }
      case PoolEventType.NewLiquidationAuction: {
        // check if the auction should be bid on by an auctioneer
        let fillerFound = false;
        for (const filler of APP_CONFIG.fillers) {
          // check if filler should try and bid on the auction
          if (!canFillerBid(filler, poolEvent.event.auctionData)) {
            continue;
          }
          // auctioneer can bid on auction
          let auctionEntry: AuctionEntry = {
            user_id: poolEvent.event.user,
            auction_type: AuctionType.Liquidation,
            filler: filler.keypair.publicKey(),
            start_block: poolEvent.event.auctionData.block,
            fill_block: 0,
            updated: poolEvent.event.ledger,
          };
          this.db.setAuctionEntry(auctionEntry);
          logger.info(
            `Added liquidation auction for user ${poolEvent.event.user} to ongoing for filler: ${filler.name}`
          );
          fillerFound = true;
          break;
        }
        if (!fillerFound) {
          logger.info(`No filler found for liquidation auction. Ignoring auction.`);
        }
        break;
      }
      case PoolEventType.DeleteLiquidationAuction: {
        // user position is now healthy and user deleted their liquidation auction
        let runResult = this.db.deleteAuctionEntry(poolEvent.event.user, AuctionType.Liquidation);
        if (runResult.changes !== 0) {
          logger.info(
            `Auction deleted. Removed liquidation auction for user ${poolEvent.event.user}`
          );
        }
        break;
      }
      case PoolEventType.FillAuction: {
        if (poolEvent.event.fillAmount === BigInt(100)) {
          // auction was fully filled, remove from ongoing auctions
          let runResult = this.db.deleteAuctionEntry(
            poolEvent.event.user,
            poolEvent.event.auctionType
          );
          if (runResult.changes !== 0) {
            logger.info(
              `Auction filled completely by ${poolEvent.event.from}. Removed auction type ${poolEvent.event.auctionType} for user ${poolEvent.event.user}`
            );
          }
          const { estimate: userPositionsEstimate, user } =
            await this.sorobanHelper.loadUserPositionEstimate(poolEvent.event.user);
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
              userPositionsEstimate.totalEffectiveCollateral /
              userPositionsEstimate.totalEffectiveLiabilities,
            collateral: collateralAddress,
            liabilities: liabilitiesAddress,
            updated: poolEvent.event.ledger,
          };
          this.db.setUserEntry(new_entry);
        }
      }
      default: {
        logger.error(`Unhandled event type: ${poolEvent.event.eventType}`);
        break;
      }
    }
  }
}
