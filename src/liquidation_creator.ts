import { PoolContract, PoolUser } from '@blend-capital/blend-sdk';
import { AuctioneerDatabase, AuctionType } from './utils/db.js';
import { SorobanHelper } from './utils/soroban_helper.js';
import { APP_CONFIG } from './utils/config.js';
import { logger } from './utils/logger.js';
import { WorkSubmission, WorkSubmissionType } from './work_submitter.js';

export async function isLiquidatable(user: PoolUser): Promise<boolean> {
  if (
    user.positionEstimates.totalEffectiveCollateral /
      user.positionEstimates.totalEffectiveLiabilities <
    0.99
  ) {
    return true;
  }
  return false;
}

export function calculateLiquidationPercent(user: PoolUser): bigint {
  const avgInverseLF =
    user.positionEstimates.totalEffectiveLiabilities / user.positionEstimates.totalBorrowed;
  const avgCF =
    user.positionEstimates.totalEffectiveCollateral / user.positionEstimates.totalSupplied;
  const estIncentive = 1 + (1 - avgCF / avgInverseLF) / 2;
  const numerator =
    user.positionEstimates.totalEffectiveLiabilities * 1.1 -
    user.positionEstimates.totalEffectiveCollateral;
  const denominator = avgInverseLF * 1.1 - avgCF * estIncentive;
  const liqPercent = BigInt(
    Math.min(
      Math.round((numerator / denominator / user.positionEstimates.totalBorrowed) * 100),
      100
    )
  );
  return liqPercent;
}

export async function scanUsers(
  db: AuctioneerDatabase,
  sorobanHelper: SorobanHelper
): Promise<WorkSubmission[]> {
  let submissions: WorkSubmission[] = [];

  let users = db.getUserEntriesUnderHealthFactor(1.2);
  for (let user of users) {
    // Check if the user already has a liquidation auction
    if ((await sorobanHelper.loadAuction(user.user_id, AuctionType.Liquidation)) === undefined) {
      const poolUser = await sorobanHelper.loadUser(user.user_id);
      if (await isLiquidatable(poolUser)) {
        const liquidationPercent = calculateLiquidationPercent(poolUser);
        submissions.push({
          type: WorkSubmissionType.LiquidateUser,
          user: user.user_id,
          liquidationPercent: liquidationPercent,
        });
      }
    }
  }
  return submissions;
}
