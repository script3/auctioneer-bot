import { PoolContract, PoolUser } from '@blend-capital/blend-sdk';
import { AuctioneerDatabase, AuctionType } from './utils/db.js';
import { SorobanHelper } from './utils/soroban_helper.js';
import { APP_CONFIG } from './utils/config.js';
import { logger } from './utils/logger.js';

export async function isLiquidatable(
  user: PoolUser,
  sorobanHelper: SorobanHelper
): Promise<boolean> {
  if (
    user.positionEstimates.totalEffectiveCollateral /
      user.positionEstimates.totalEffectiveLiabilities <
      1 &&
    (await sorobanHelper.loadAuction(user.user, AuctionType.Liquidation)) === undefined
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
  const numberator =
    user.positionEstimates.totalEffectiveLiabilities * 1.1 -
    user.positionEstimates.totalEffectiveCollateral;
  const denominator = avgInverseLF * 1.1 - avgCF * estIncentive;
  const liqPercent = BigInt(
    Math.min(
      Math.round((numberator / denominator / user.positionEstimates.totalBorrowed) * 100),
      100
    )
  );
  return liqPercent;
}

export async function scanForLiquidations(
  db: AuctioneerDatabase,
  sorobanHelper: SorobanHelper
): Promise<void> {
  try {
    let users = db.getUserEntriesUnderHealthFactor(1.2);
    const pool = new PoolContract(APP_CONFIG.poolAddress);
    for (const user of users) {
      let poolUser = await sorobanHelper.loadUser(user.user_id);
      if (await isLiquidatable(poolUser, sorobanHelper)) {
        const liqPercent = calculateLiquidationPercent(poolUser);
        let op = pool.newLiquidationAuction({
          user: user.user_id,
          percent_liquidated: liqPercent,
        });
        await sorobanHelper.submitTransaction(op, APP_CONFIG.fillers[0].keypair);
      }
    }
  } catch (error) {
    logger.error('Error scanning for liquidations', error);
  }
}
