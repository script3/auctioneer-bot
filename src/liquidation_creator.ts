import { PositionsEstimate } from '@blend-capital/blend-sdk';
import { AuctioneerDatabase, AuctionType } from './utils/db.js';
import { SorobanHelper } from './utils/soroban_helper.js';
import { WorkSubmission, WorkSubmissionType } from './work_submitter.js';

export async function isLiquidatable(user: PositionsEstimate): Promise<boolean> {
  if (user.totalEffectiveCollateral / user.totalEffectiveLiabilities < 0.99) {
    return true;
  }
  return false;
}

export function calculateLiquidationPercent(user: PositionsEstimate): bigint {
  const avgInverseLF = user.totalEffectiveLiabilities / user.totalBorrowed;
  const avgCF = user.totalEffectiveCollateral / user.totalSupplied;
  const estIncentive = 1 + (1 - avgCF / avgInverseLF) / 2;
  const numerator = user.totalEffectiveLiabilities * 1.1 - user.totalEffectiveCollateral;
  const denominator = avgInverseLF * 1.1 - avgCF * estIncentive;
  const liqPercent = BigInt(
    Math.min(Math.round((numerator / denominator / user.totalBorrowed) * 100), 100)
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
      const { estimate: poolUserEstimate } = await sorobanHelper.loadUserPositionEstimate(
        user.user_id
      );
      if (await isLiquidatable(poolUserEstimate)) {
        const liquidationPercent = calculateLiquidationPercent(poolUserEstimate);
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
