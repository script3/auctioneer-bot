import { PoolContract } from '@blend-capital/blend-sdk';
import { APP_CONFIG } from './utils/config.js';
import { AuctioneerDatabase } from './utils/db.js';
import { stringify } from './utils/json.js';
import { logger } from './utils/logger.js';
import { SorobanHelper } from './utils/soroban_helper.js';
import { SubmissionQueue } from './utils/submission_queue.js';

export type WorkSubmission = UserLiquidation;

export enum WorkSubmissionType {
  LiquidateUser = 'liquidate',
}

export interface UserLiquidation {
  type: WorkSubmissionType.LiquidateUser;
  user: string;
  liquidationPercent: bigint;
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
      await sorobanHelper.submitTransaction(op, APP_CONFIG.fillers[0].keypair);
      logger.info(`Submitted liquidation for user: ${userLiquidation.user}`);
      return true;
    } catch (e: any) {
      logger.error(`Error submitting user liquidation: ${stringify(userLiquidation)}`, e);
      return false;
    }
  }

  onDrop(submission: WorkSubmission): void {
    // TODO: Send slack alert for dropped submission
    switch (submission.type) {
      case WorkSubmissionType.LiquidateUser:
        logger.error(`Dropped liquidation for user: ${submission.user}`);
        break;
    }
  }
}
