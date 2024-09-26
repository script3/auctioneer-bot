import { PoolContract } from '@blend-capital/blend-sdk';
import { APP_CONFIG } from './utils/config.js';
import { AuctioneerDatabase, AuctionType } from './utils/db.js';
import { stringify } from './utils/json.js';
import { logger } from './utils/logger.js';
import { SorobanHelper } from './utils/soroban_helper.js';
import { SubmissionQueue } from './utils/submission_queue.js';
import { sendSlackNotification } from './utils/slack_notifier.js';
import { log } from 'winston';

export type WorkSubmission = UserLiquidation | BadDebtTransfer | BadDebtAuction;

export enum WorkSubmissionType {
  LiquidateUser = 'liquidate',
  BadDebtTransfer = 'bad_debt_transfer',
  BadDebtAuction = 'bad_debt_auction',
}

export interface BadDebtTransfer {
  type: WorkSubmissionType.BadDebtTransfer;
  user: string;
}

export interface UserLiquidation {
  type: WorkSubmissionType.LiquidateUser;
  user: string;
  liquidationPercent: bigint;
}

export interface BadDebtAuction {
  type: WorkSubmissionType.BadDebtAuction;
}

export class WorkSubmitter extends SubmissionQueue<WorkSubmission> {
  db: AuctioneerDatabase;

  constructor(db: AuctioneerDatabase) {
    super();
    this.db = db;
  }

  // @dev: Return true to acknowledge the submission, or false to retry
  async submit(submission: WorkSubmission): Promise<boolean> {
    let sorobanHelper = new SorobanHelper();

    switch (submission.type) {
      case WorkSubmissionType.LiquidateUser:
        return this.submitUserLiquidation(sorobanHelper, submission);
      case WorkSubmissionType.BadDebtTransfer:
        return this.submitBadDebtTransfer(sorobanHelper, submission);
      case WorkSubmissionType.BadDebtAuction:
        return this.submitBadDebtAuction(sorobanHelper);
      default:
        logger.error(`Invalid submission type: ${stringify(submission)}`);
        // consume the submission
        return true;
    }
  }

  async submitUserLiquidation(
    sorobanHelper: SorobanHelper,
    userLiquidation: UserLiquidation
  ): Promise<boolean> {
    try {
      const pool = new PoolContract(APP_CONFIG.poolAddress);
      let op = pool.newLiquidationAuction({
        user: userLiquidation.user,
        percent_liquidated: userLiquidation.liquidationPercent,
      });
      const auctionExists =
        (await sorobanHelper.loadAuction(userLiquidation.user, AuctionType.Liquidation)) !==
        undefined;
      if (auctionExists) {
        return true;
      }
      await sorobanHelper.submitTransaction(op, APP_CONFIG.keypair);
      const logMessage = `Successfully submitted liquidation for user: ${userLiquidation.user} Liquidation Percent: ${userLiquidation.liquidationPercent}`;
      logger.info(logMessage);
      await sendSlackNotification(logMessage);
      return true;
    } catch (e: any) {
      const logMessage =
        `Error creating user liquidation\n` +
        `User: ${userLiquidation.user}\n` +
        `Liquidation Percent: ${userLiquidation.liquidationPercent}\nError: ${stringify(e)}\n`;
      logger.error(logMessage);
      await sendSlackNotification(`<!channel>` + logMessage);
      return false;
    }
  }

  async submitBadDebtTransfer(
    sorobanHelper: SorobanHelper,
    badDebtTransfer: BadDebtTransfer
  ): Promise<boolean> {
    try {
      const pool = new PoolContract(APP_CONFIG.poolAddress);
      let op = pool.badDebt(badDebtTransfer.user);
      await sorobanHelper.submitTransaction(op, APP_CONFIG.keypair);
      const logMessage = `Successfully submitted bad debt transfer for user: ${badDebtTransfer.user}`;
      await sendSlackNotification(logMessage);
      logger.info(logMessage);
      return true;
    } catch (e: any) {
      const logMessage =
        `Error transfering bad debt\n` + `User: ${badDebtTransfer.user}\n` + `Error: ${e}\n`;
      logger.error(logMessage);
      await sendSlackNotification(`<!channel>` + logMessage);
      return false;
    }
  }

  async submitBadDebtAuction(sorobanHelper: SorobanHelper): Promise<boolean> {
    try {
      const pool = new PoolContract(APP_CONFIG.poolAddress);
      let op = pool.newBadDebtAuction();
      const auctionExists =
        (await sorobanHelper.loadAuction(APP_CONFIG.backstopAddress, AuctionType.BadDebt)) !==
        undefined;
      if (auctionExists) {
        return true;
      }
      await sorobanHelper.submitTransaction(op, APP_CONFIG.keypair);
      const logMessage = `Successfully submitted bad debt auction`;
      logger.info(logMessage);
      await sendSlackNotification(logMessage);
      return true;
    } catch (e: any) {
      const logMessage = `Error creating bad debt auction\n` + `Error: ${e}\n`;
      logger.error(logMessage);
      await sendSlackNotification(`<!channel>` + logMessage);
      return false;
    }
  }

  async onDrop(submission: WorkSubmission): Promise<void> {
    // TODO: Send slack alert for dropped submission
    let logMessage: string;
    switch (submission.type) {
      case WorkSubmissionType.LiquidateUser:
        logMessage = `Dropped liquidation for user: ${submission.user}`;
        break;
      case WorkSubmissionType.BadDebtTransfer:
        logMessage = `Dropped bad debt transfer for user: ${submission.user}`;
        break;
      case WorkSubmissionType.BadDebtAuction:
        logMessage = `Dropped bad debt auction`;
        break;
    }
    logger.error(logMessage);
    await sendSlackNotification(logMessage);
  }
}
