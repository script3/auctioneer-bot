import { ContractError, ContractErrorType, PoolContractV2 } from '@blend-capital/blend-sdk';
import { APP_CONFIG, Filler } from './utils/config.js';
import { AuctionType } from './utils/db.js';
import { serializeError, stringify } from './utils/json.js';
import { logger } from './utils/logger.js';
import { sendNotification } from './utils/notifier.js';
import { SorobanHelper } from './utils/soroban_helper.js';
import { SubmissionQueue } from './utils/submission_queue.js';
import { Address, Contract, nativeToScVal } from '@stellar/stellar-sdk';

export type WorkSubmission = AuctionCreation | BadDebtTransfer;

export enum WorkSubmissionType {
  AuctionCreation = 'create_auction',
  BadDebtTransfer = 'bad_debt_transfer',
}

export interface BaseWorkSubmission {
  type: WorkSubmissionType;
  poolId: string;
}

export interface BadDebtTransfer extends BaseWorkSubmission {
  type: WorkSubmissionType.BadDebtTransfer;
  user: string;
}

export interface AuctionCreation extends BaseWorkSubmission {
  type: WorkSubmissionType.AuctionCreation;
  user: string;
  auctionType: AuctionType;
  auctionPercent: number;
  bid: string[];
  lot: string[];
}

export class WorkSubmitter extends SubmissionQueue<WorkSubmission> {
  constructor() {
    super();
  }

  // @dev: Return true to acknowledge the submission, or false to retry
  async submit(submission: WorkSubmission): Promise<boolean> {
    let sorobanHelper = new SorobanHelper();

    switch (submission.type) {
      case WorkSubmissionType.AuctionCreation:
        return this.submitAuction(sorobanHelper, submission);
      case WorkSubmissionType.BadDebtTransfer:
        return this.submitBadDebtTransfer(sorobanHelper, submission);
      default:
        logger.error(`Invalid submission type: ${stringify(submission)}`);
        // consume the submission
        return true;
    }
  }

  async submitAuction(sorobanHelper: SorobanHelper, auction: AuctionCreation): Promise<boolean> {
    try {
      logger.info(
        `Creating auction ${auction.auctionType} for user: ${auction.user} in pool: ${auction.poolId}`
      );

      const pool = new PoolContractV2(auction.poolId);
      const op = pool.newAuction({
        user: auction.user,
        auction_type: auction.auctionType,
        percent: auction.auctionPercent,
        bid: auction.bid,
        lot: auction.lot,
      });

      const auctionExists =
        (await sorobanHelper.loadAuction(auction.poolId, auction.user, auction.auctionType)) !==
        undefined;
      if (auctionExists) {
        logger.info(
          `Auction ${auction.auctionType} already exists for user: ${auction.user} in pool: ${auction.poolId}`
        );
        return true;
      }
      await sorobanHelper.submitTransaction(op, APP_CONFIG.keypair);
      const logMessage =
        `Successfully created auction\n` +
        `Auction Type: ${AuctionType[auction.auctionType]}\n` +
        `Pool: ${auction.poolId}\n` +
        `User: ${auction.user}\n` +
        `Auction Percent: ${auction.auctionPercent}\n` +
        `Bid: ${stringify(auction.bid)}\n` +
        `Lot: ${stringify(auction.lot)}\n`;

      logger.info(logMessage);
      await sendNotification(logMessage);
      return true;
    } catch (e: any) {
      const logMessage =
        `Error creating auction\n` +
        `Auction Type: ${AuctionType[auction.auctionType]}\n` +
        `Pool: ${auction.poolId}\n` +
        `User: ${auction.user}\n` +
        `Auction Percent: ${auction.auctionPercent}\n` +
        `Bid: ${stringify(auction.bid)}\n` +
        `Lot: ${stringify(auction.lot)}\n` +
        `Error: ${stringify(serializeError(e))}\n`;
      logger.error(logMessage);
      await sendNotification(logMessage, true);

      // if pool throws a "LIQ_TOO_SMALL" or "LIQ_TOO_LARGE" error, adjust the fill percentage
      // by 1 percentage point before retrying.
      if (e instanceof ContractError) {
        if (e.type === ContractErrorType.InvalidLiqTooSmall && auction.auctionPercent < 100) {
          auction.auctionPercent += 1;
        } else if (e.type === ContractErrorType.InvalidLiqTooLarge && auction.auctionPercent > 1) {
          auction.auctionPercent -= 1;
        }
      }
      return false;
    }
  }

  async submitBadDebtTransfer(
    sorobanHelper: SorobanHelper,
    badDebtTransfer: BadDebtTransfer
  ): Promise<boolean> {
    try {
      logger.info(
        `Transferring bad debt to backstop for user: ${badDebtTransfer.user} in pool: ${badDebtTransfer.poolId}`
      );
      const pool = new PoolContractV2(badDebtTransfer.poolId);
      const op = pool.badDebt(badDebtTransfer.user);
      await sorobanHelper.submitTransaction(op, APP_CONFIG.keypair);
      const logMessage =
        `Successfully transferred bad debt to backstop\n` +
        `Pool: ${badDebtTransfer.poolId}\n` +
        `User: ${badDebtTransfer.user}`;
      await sendNotification(logMessage);
      logger.info(logMessage);
      return true;
    } catch (e: any) {
      const logMessage =
        `Error transfering bad debt\n` +
        `Pool: ${badDebtTransfer.poolId}\n` +
        `User: ${badDebtTransfer.user}` +
        `Error: ${stringify(serializeError(e))}\n`;
      logger.error(logMessage);
      await sendNotification(logMessage, true);
      return false;
    }
  }

  async onDrop(submission: WorkSubmission): Promise<void> {
    // TODO: Send slack alert for dropped submission
    let logMessage: string;
    switch (submission.type) {
      case WorkSubmissionType.AuctionCreation:
        logMessage =
          `Dropped auction creation\n` +
          `pool: ${submission.poolId}\n` +
          `Auction Type: ${submission.auctionType}\n` +
          `user: ${submission.user}`;
        break;
      case WorkSubmissionType.BadDebtTransfer:
        logMessage =
          `Dropped bad debt transfer\n` +
          `pool: ${submission.poolId}\n` +
          `user: ${submission.user}`;
        break;
    }
    logger.error(logMessage);
    await sendNotification(logMessage);
  }
}
