import { Pool, PoolOracle, Positions, PositionsEstimate } from '@blend-capital/blend-sdk';
import { updateUser } from './user.js';
import { APP_CONFIG } from './utils/config.js';
import { AuctioneerDatabase, AuctionType } from './utils/db.js';
import { logger } from './utils/logger.js';
import { SorobanHelper } from './utils/soroban_helper.js';
import { WorkSubmission, WorkSubmissionType } from './work_submitter.js';
import { sendNotification } from './utils/notifier.js';
import { stringify } from './utils/json.js';

/**
 * A representation of a position taking into account the oracle price.
 */
interface PricedPosition {
  assetId: string;
  index: number;
  effectiveAmount: number;
  baseAmount: number;
}

/**
 * The result of a liquidation calculation.
 * Contains the auction percent, lot and bid asset ids.
 */
interface LiquidationCalc {
  auctionPercent: number;
  lot: string[];
  bid: string[];
}

/**
 * Check if a user is liquidatable
 * @param user - The positions estimate of the user
 * @returns true if the user is liquidatable, false otherwise
 */
export function isLiquidatable(user: PositionsEstimate): boolean {
  if (
    user.totalEffectiveLiabilities > 0 &&
    user.totalEffectiveCollateral > 0 &&
    user.totalEffectiveCollateral / user.totalEffectiveLiabilities < 0.998
  ) {
    return true;
  }
  return false;
}

/**
 * Check if a user had bad debt
 * @param user - The positions estimate of the user
 * @returns True if the user has bad debt, false otherwise
 */
export function isBadDebt(user: PositionsEstimate): boolean {
  if (user.totalEffectiveCollateral === 0 && user.totalEffectiveLiabilities > 0) {
    return true;
  }
  return false;
}

/**
 * Calculate the liquidation percent for position
 * @param user - The positions estimate of the user
 * @returns The liquidation percent
 */
export function calculateLiquidation(
  pool: Pool,
  user: Positions,
  estimate: PositionsEstimate,
  oracle: PoolOracle
): LiquidationCalc {
  let collateral: PricedPosition[] = [];
  let liabilities: PricedPosition[] = [];

  for (let [index, amount] of user.collateral) {
    let assetId = pool.metadata.reserveList[index];
    let oraclePrice = oracle.getPriceFloat(assetId);
    let reserve = pool.reserves.get(assetId);
    if (oraclePrice === undefined || reserve === undefined) {
      continue;
    }
    let effectiveAmount = reserve.toEffectiveAssetFromBTokenFloat(amount) * oraclePrice;
    let baseAmount = reserve.toAssetFromBTokenFloat(amount) * oraclePrice;
    collateral.push({
      assetId,
      index,
      effectiveAmount,
      baseAmount,
    });
  }
  for (let [index, amount] of user.liabilities) {
    let assetId = pool.metadata.reserveList[index];
    let oraclePrice = oracle.getPriceFloat(assetId);
    let reserve = pool.reserves.get(assetId);
    if (oraclePrice === undefined || reserve === undefined) {
      continue;
    }
    let effectiveAmount = reserve.toEffectiveAssetFromDTokenFloat(amount) * oraclePrice;
    let baseAmount = reserve.toAssetFromDTokenFloat(amount) * oraclePrice;
    liabilities.push({
      assetId,
      index,
      effectiveAmount,
      baseAmount,
    });
  }

  // sort ascending by effective amount
  collateral.sort((a, b) => a.effectiveAmount - b.effectiveAmount);
  liabilities.sort((a, b) => a.effectiveAmount - b.effectiveAmount);
  let largestCollateral = collateral.pop();
  let largestLiability = liabilities.pop();

  if (largestCollateral === undefined || largestLiability === undefined) {
    throw new Error('No collaterals or liabilities found for liquidation calculation');
  }

  let liabilitesToReduce =
    estimate.totalEffectiveLiabilities * 1.06 - estimate.totalEffectiveCollateral;
  if (liabilitesToReduce <= 0) {
    throw new Error('No liabilities to reduce for liquidation calculation');
  }

  let effectiveCollateral = largestCollateral.effectiveAmount;
  let baseCollateral = largestCollateral.baseAmount;
  let effectiveLiabilities = largestLiability.effectiveAmount;
  let baseLiabilities = largestLiability.baseAmount;

  let bid: string[] = [largestLiability.assetId];
  let lot: string[] = [largestCollateral.assetId];
  let liqPercent = calculateLiqPercent(
    effectiveCollateral,
    baseCollateral,
    effectiveLiabilities,
    baseLiabilities,
    liabilitesToReduce
  );
  while (liqPercent > 100 || liqPercent === 0) {
    if (liqPercent > 100) {
      let nextLiability = liabilities.pop();
      if (nextLiability === undefined) {
        let nextCollateral = collateral.pop();
        if (nextCollateral === undefined) {
          // full liquidation required
          return {
            auctionPercent: 100,
            lot: Array.from(user.collateral).map(([index]) => pool.metadata.reserveList[index]),
            bid: Array.from(user.liabilities).map(([index]) => pool.metadata.reserveList[index]),
          };
        }
        effectiveCollateral += nextCollateral.effectiveAmount;
        baseCollateral += nextCollateral.baseAmount;
        lot.push(nextCollateral.assetId);
      } else {
        effectiveLiabilities += nextLiability.effectiveAmount;
        baseLiabilities += nextLiability.baseAmount;
        bid.push(nextLiability.assetId);
      }
    } else if (liqPercent == 0) {
      let nextCollateral = collateral.pop();
      if (nextCollateral === undefined) {
        // full liquidation required
        return {
          auctionPercent: 100,
          lot: Array.from(user.collateral).map(([index]) => pool.metadata.reserveList[index]),
          bid: Array.from(user.liabilities).map(([index]) => pool.metadata.reserveList[index]),
        };
      }
      effectiveCollateral += nextCollateral.effectiveAmount;
      baseCollateral += nextCollateral.baseAmount;
      lot.push(nextCollateral.assetId);
    }
    liqPercent = calculateLiqPercent(
      effectiveCollateral,
      baseCollateral,
      effectiveLiabilities,
      baseLiabilities,
      liabilitesToReduce
    );
  }

  return {
    auctionPercent: liqPercent,
    lot,
    bid,
  };
}

/**
 * Calculate the liquidation percent to bring the user back to a 1.06 HF
 * @param effectiveCollateral - The effective collateral of the position to liquidate, in the pool's oracle denomination
 * @param baseCollateral - The base collateral of the position to liquidate, in the pool's oracle denomination
 * @param effectiveLiabilities - The effective liabilities of the position to liquidate, in the pool's oracle denomination
 * @param baseLiabilities - The base liabilities of the position to liquidate, in the pool's oracle denomination
 * @param excessLiabilities - The excess liabilities over the borrow limit, in the pool's oracle denomination
 * @returns A percentage of the borrow limit that needs to be liquidated.
 *          A percentage of 0 means there is not enough collateral to cover the liquidated liabilities.
 *          A percentage over 100 means there is not enough liabilities being liquidated to cover the excess.
 */
function calculateLiqPercent(
  effectiveCollateral: number,
  baseCollateral: number,
  effectiveLiabilities: number,
  baseLiabilities: number,
  excessLiabilities: number
) {
  let avgCF = effectiveCollateral / baseCollateral;
  let avgLF = effectiveLiabilities / baseLiabilities;
  let estIncentive = 1 + (1 - avgCF / avgLF) / 2;
  // The factor by which the effective liabilities are reduced per raw liability
  let borrowLimitFactor = avgLF * 1.06 - estIncentive * avgCF;

  let totalBorrowLimitRecovered = borrowLimitFactor * baseLiabilities;
  let liqPercent = Math.round((excessLiabilities / totalBorrowLimitRecovered) * 100);
  let requiredBaseCollateral = (liqPercent / 100) * baseLiabilities * estIncentive;

  if (requiredBaseCollateral > baseCollateral) {
    return 0; // Not enough collateral to cover the liquidation
  }

  return liqPercent;
}

/**
 * Check all tracked users for liquidations
 * @param db - The database
 * @param sorobanHelper - The soroban helper
 * @returns A list of liquidations to be submitted
 */
export async function scanUsers(
  db: AuctioneerDatabase,
  sorobanHelper: SorobanHelper
): Promise<WorkSubmission[]> {
  let userPoolMap = new Map<string, string[]>();
  let users = db.getUserEntriesUnderHealthFactor(1.2);
  for (const user of users) {
    if (!userPoolMap.has(user.pool_id)) {
      userPoolMap.set(user.pool_id, []);
    }
    userPoolMap.get(user.pool_id)!.push(user.user_id);
  }

  let submissions: WorkSubmission[] = [];
  for (const pool of APP_CONFIG.pools) {
    const users = userPoolMap.get(pool) || [];
    users.push(APP_CONFIG.backstopAddress);
    submissions.push(
      ...(await checkUsersForLiquidationsAndBadDebt(db, sorobanHelper, pool, users))
    );
  }
  return submissions;
}

/**
 * Check a provided list of users for liquidations and bad debt
 * @param db - The database
 * @param sorobanHelper - The soroban helper
 * @param users - The list of users to check
 * @returns A list of liquidations to be submitted
 */
export async function checkUsersForLiquidationsAndBadDebt(
  db: AuctioneerDatabase,
  sorobanHelper: SorobanHelper,
  poolId: string,
  user_ids: string[]
): Promise<WorkSubmission[]> {
  const pool = await sorobanHelper.loadPool(poolId);
  logger.info(`Checking ${user_ids.length} users for liquidations..`);
  let submissions: WorkSubmission[] = [];
  for (let user of user_ids) {
    try {
      // Check if the user already has a liquidation auction
      if (user === APP_CONFIG.backstopAddress) {
        const { estimate: backstopPostionsEstimate, user: backstop } =
          await sorobanHelper.loadUserPositionEstimate(poolId, user);
        if (
          isBadDebt(backstopPostionsEstimate) &&
          (await sorobanHelper.loadAuction(poolId, user, AuctionType.BadDebt)) === undefined
        ) {
          let backstopLiabilities = Array.from(backstop.positions.liabilities.keys()).map(
            (index) => pool.metadata.reserveList[index]
          );
          if (backstopLiabilities.length >= pool.metadata.maxPositions) {
            backstopLiabilities = backstopLiabilities.slice(0, pool.metadata.maxPositions - 1);
          }
          submissions.push({
            type: WorkSubmissionType.AuctionCreation,
            poolId,
            user: APP_CONFIG.backstopAddress,
            auctionType: AuctionType.BadDebt,
            auctionPercent: 100,
            bid: backstopLiabilities,
            lot: [APP_CONFIG.backstopTokenAddress],
          });
        }
      } else if (
        (await sorobanHelper.loadAuction(poolId, user, AuctionType.Liquidation)) === undefined
      ) {
        const { estimate: poolUserEstimate, user: poolUser } =
          await sorobanHelper.loadUserPositionEstimate(poolId, user);
        const oracle = await sorobanHelper.loadPoolOracle(poolId);
        updateUser(db, pool, poolUser, poolUserEstimate);
        if (isLiquidatable(poolUserEstimate)) {
          const newLiq = calculateLiquidation(pool, poolUser.positions, poolUserEstimate, oracle);
          submissions.push({
            type: WorkSubmissionType.AuctionCreation,
            poolId,
            user,
            auctionPercent: newLiq.auctionPercent,
            auctionType: AuctionType.Liquidation,
            bid: newLiq.bid,
            lot: newLiq.lot,
          });
        } else if (isBadDebt(poolUserEstimate)) {
          submissions.push({
            type: WorkSubmissionType.BadDebtTransfer,
            poolId,
            user: user,
          });
        }
      }
    } catch (e) {
      const errorLog =
        `Error checking for bad debt or liquidation\n` +
        `Pool: ${poolId}\n` +
        `User: ${user}\n` +
        `Error: ${e}`;
      logger.error(errorLog);
      sendNotification(errorLog);
    }
  }
  return submissions;
}
