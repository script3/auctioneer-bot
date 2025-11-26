import {
  Auction,
  AuctionType,
  FixedMath,
  Pool,
  PoolOracle,
  Request,
  RequestType,
} from '@blend-capital/blend-sdk';
import { getFillerAvailableBalances, getFillerProfitPct } from './filler.js';
import { APP_CONFIG, PoolConfig } from './utils/config.js';
import { AuctioneerDatabase } from './utils/db.js';
import { stringify } from './utils/json.js';
import { logger } from './utils/logger.js';
import { SorobanHelper } from './utils/soroban_helper.js';

export interface AuctionFill {
  // The block number to fill the auction at
  block: number;
  // The percent of the auction to fill
  percent: number;
  // The expected lot value the filler will receive
  lotValue: number;
  // The expected bid value the filler will pay
  bidValue: number;
  // The requests to fill the auction
  requests: Request[];
}

export interface AuctionValue {
  effectiveCollateral: number;
  effectiveLiabilities: number;
  lotValue: number;
  bidValue: number;
}

export async function calculateAuctionFill(
  poolConfig: PoolConfig,
  auction: Auction,
  nextLedger: number,
  sorobanHelper: SorobanHelper,
  db: AuctioneerDatabase
): Promise<AuctionFill> {
  try {
    const pool = await sorobanHelper.loadPool(poolConfig.poolAddress);
    const poolOracle = await sorobanHelper.loadPoolOracle(poolConfig.poolAddress);

    const auctionValue = await calculateAuctionValue(auction, pool, poolOracle, sorobanHelper, db);
    return await calculateBlockFillAndPercent(
      poolConfig,
      auction,
      auctionValue,
      pool,
      poolOracle,
      nextLedger,
      sorobanHelper
    );
  } catch (e: any) {
    logger.error(`Error calculating auction fill.`, e);
    throw e;
  }
}

/**
 * Calculate the block fill and fill percent for a given auction.
 *
 * @param poolConfig - The pool configuration to calculate the block fill for
 * @param auction - The auction to calculate the fill for
 * @param auctionValue - The calculate value of the base auction
 * @param nextLedger - The next ledger number
 * @param sorobanHelper - The soroban helper to use for the calculation
 */
export async function calculateBlockFillAndPercent(
  poolConfig: PoolConfig,
  auction: Auction,
  auctionValue: AuctionValue,
  pool: Pool,
  poolOracle: PoolOracle,
  nextLedger: number,
  sorobanHelper: SorobanHelper
): Promise<AuctionFill> {
  let fillBlockDelay = 0;
  let fillPercent = 100;
  let requests: Request[] = [];

  // get relevant assets for the auction
  const relevant_assets = [];
  switch (auction.type) {
    case AuctionType.Liquidation:
      relevant_assets.push(...Array.from(auction.data.lot.keys()));
      relevant_assets.push(...Array.from(auction.data.bid.keys()));
      relevant_assets.push(poolConfig.primaryAsset);
      break;
    case AuctionType.Interest:
      relevant_assets.push(APP_CONFIG.usdcAddress);
      break;
    case AuctionType.BadDebt:
      relevant_assets.push(...Array.from(auction.data.bid.keys()));
      relevant_assets.push(poolConfig.primaryAsset);
      break;
  }
  const fillerBalances = await getFillerAvailableBalances(
    [...new Set(relevant_assets)],
    sorobanHelper
  );

  // auction value is the full auction
  let { effectiveCollateral, effectiveLiabilities, lotValue, bidValue } = auctionValue;

  // find the block delay where the auction meets the required profit percentage
  const profitPercent = getFillerProfitPct(poolConfig, auction.data);

  if (lotValue >= bidValue * (1 + profitPercent)) {
    const minLotAmount = bidValue * (1 + profitPercent);
    fillBlockDelay = 200 - (lotValue - minLotAmount) / (lotValue / 200);
  } else {
    const maxBidAmount = lotValue * (1 - profitPercent);
    fillBlockDelay = 200 + (bidValue - maxBidAmount) / (bidValue / 200);
  }
  fillBlockDelay = Math.min(Math.max(Math.ceil(fillBlockDelay), 0), 400);
  // apply force fill auction boundries to profit calculations
  if (poolConfig.forceFill) {
    fillBlockDelay = Math.min(fillBlockDelay, 350);
  }

  // if calculated fillBlock has already passed, adjust fillBlock to the next ledger
  if (auction.data.block + fillBlockDelay < nextLedger) {
    fillBlockDelay = Math.min(nextLedger - auction.data.block, 400);
  }

  let bidScalar = fillBlockDelay <= 200 ? 1 : 1 - Math.max(0, fillBlockDelay - 200) / 200;
  let lotScalar = fillBlockDelay < 200 ? fillBlockDelay / 200 : 1;

  const [scaledAuction] = auction.scale(auction.data.block + fillBlockDelay, 100);

  // filler waits until they can fully fill the interest auction
  if (auction.type === AuctionType.Interest) {
    const usdcBalance = FixedMath.toFloat(fillerBalances.get(APP_CONFIG.usdcAddress) ?? 0n, 7);
    const usdcMaxIn = auctionValue.bidValue * bidScalar * 1.01; // allow for 1% slippage from mint price
    if (usdcMaxIn > usdcBalance) {
      const additionalUsdcNeeded = usdcMaxIn - usdcBalance;
      const usdcStepSize = auctionValue.bidValue / 200;
      if (additionalUsdcNeeded >= 0 && usdcStepSize > 0) {
        const additionalDelay = Math.ceil(additionalUsdcNeeded / usdcStepSize);
        fillBlockDelay = Math.min(400, fillBlockDelay + additionalDelay);
      }
    }
  } else if (auction.type === AuctionType.Liquidation || auction.type === AuctionType.BadDebt) {
    const { estimate: fillerPositionEstimates } = await sorobanHelper.loadUserPositionEstimate(
      pool.id,
      APP_CONFIG.fillerKeypair.publicKey()
    );
    let canFillWithSafeHF = false;
    let iterations = 0;
    while (!canFillWithSafeHF && iterations < 5) {
      const loopFillerBalances = new Map(fillerBalances);
      requests = [];
      logger.info(
        `Calculating auction fill iteration ${iterations} with delay ${fillBlockDelay} for user ${auction.user} in pool ${pool.id} with percent ${fillPercent}`
      );
      const [loopScaledAuction] = auction.scale(auction.data.block + fillBlockDelay, fillPercent);
      iterations++;
      // inflate minHealthFactor slightly, to allow for the unwind logic to unwind looped positions safely
      const additionalLiabilities = effectiveLiabilities * bidScalar * (fillPercent / 100);
      const additionalCollateral = effectiveCollateral * lotScalar * (fillPercent / 100);
      const safeHealthFactor = poolConfig.minHealthFactor * 1.1;
      let limitToHF =
        (fillerPositionEstimates.totalEffectiveCollateral + additionalCollateral) /
          safeHealthFactor -
        (fillerPositionEstimates.totalEffectiveLiabilities + additionalLiabilities);
      let liabilitiesRepaid = 0;
      let collateralAdded = 0;

      logger.info(
        `Auction value: ${stringify(auctionValue)}. Bid scalar: ${bidScalar}. Lot scalar: ${lotScalar}. Limit to HF: ${limitToHF}`
      );

      // attempt to repay any liabilities the filler has took on from the bids
      for (const [assetId, amount] of loopScaledAuction.data.bid) {
        const balance = loopFillerBalances.get(assetId) ?? 0n;
        if (balance > 0n && amount > 0n) {
          const reserve = pool.reserves.get(assetId);
          const oraclePrice = poolOracle.getPriceFloat(assetId);
          if (reserve !== undefined && oraclePrice !== undefined) {
            // 100n prevents dust positions from being created, and is deducted from the repaid liability
            const amountAsUnderlying = reserve.toAssetFromDToken(amount) + 100n;
            const repaidLiability = amountAsUnderlying <= balance ? amountAsUnderlying : balance;
            const effectiveLiability =
              FixedMath.toFloat(repaidLiability - 100n, reserve.config.decimals) *
              reserve.getLiabilityFactor() *
              oraclePrice;
            limitToHF += effectiveLiability;
            liabilitiesRepaid += effectiveLiability;
            loopFillerBalances.set(assetId, balance - repaidLiability);
            requests.push({
              request_type: RequestType.Repay,
              address: assetId,
              amount: repaidLiability,
            });
          }
        }
      }

      // withdraw any collateral that has no CF to reduce position count
      if (auction.type === AuctionType.Liquidation) {
        for (const [assetId] of loopScaledAuction.data.lot) {
          const reserve = pool.reserves.get(assetId);
          if (reserve !== undefined && reserve.getCollateralFactor() === 0) {
            requests.push({
              request_type: RequestType.WithdrawCollateral,
              address: assetId,
              amount: BigInt('9223372036854775807'),
            });
          }
        }
      }

      if (limitToHF < 0) {
        // if we still are under the health factor, we need to try and add more of the fillers primary asset as collateral
        const primaryBalance = loopFillerBalances.get(poolConfig.primaryAsset) ?? 0n;
        const primaryReserve = pool.reserves.get(poolConfig.primaryAsset);
        const primaryOraclePrice = poolOracle.getPriceFloat(poolConfig.primaryAsset);
        if (
          primaryReserve !== undefined &&
          primaryOraclePrice !== undefined &&
          primaryBalance > 0n
        ) {
          const primaryCollateralRequired = Math.ceil(
            (Math.abs(limitToHF) / (primaryReserve.getCollateralFactor() * primaryOraclePrice)) *
              safeHealthFactor
          );
          const primaryBalFloat = FixedMath.toFloat(primaryBalance, primaryReserve.config.decimals);
          const primaryDeposit = Math.min(primaryBalFloat, primaryCollateralRequired);
          const collateral =
            primaryDeposit * primaryReserve.getCollateralFactor() * primaryOraclePrice;
          limitToHF += collateral / safeHealthFactor;
          collateralAdded += collateral;
          requests.push({
            request_type: RequestType.SupplyCollateral,
            address: poolConfig.primaryAsset,
            amount: FixedMath.toFixed(primaryDeposit, primaryReserve.config.decimals),
          });
        }

        if (limitToHF < 0) {
          const preBorrowLimit = Math.max(
            (fillerPositionEstimates.totalEffectiveCollateral + collateralAdded) /
              safeHealthFactor -
              (fillerPositionEstimates.totalEffectiveLiabilities - liabilitiesRepaid),
            0
          );
          const incomingLiabilities =
            additionalLiabilities - additionalCollateral / safeHealthFactor;
          const adjustedFillPercent = Math.floor(
            Math.min(1, preBorrowLimit / incomingLiabilities) * fillPercent
          );
          if (adjustedFillPercent < 1) {
            // filler can't take on additional liabilities even with reduced fill percent. Push back fill block until
            // more collateral is received than liabilities taken on, or no liabilities are taken on
            const excessLiabilitiesAtBlock200 =
              fillerPositionEstimates.totalEffectiveLiabilities +
              auctionValue.effectiveLiabilities -
              liabilitiesRepaid -
              (fillerPositionEstimates.totalEffectiveCollateral +
                auctionValue.effectiveCollateral +
                collateralAdded) /
                safeHealthFactor;
            const blockDelay =
              Math.ceil(
                100 * (Math.abs(excessLiabilitiesAtBlock200) / auctionValue.effectiveLiabilities)
              ) / 0.5;
            fillBlockDelay = Math.min(200 + blockDelay, 400);
            logger.info(
              `Unable to fill auction at expected profit due to insufficient health factor. Auction fill at block 200 exceeds HF borrow limit by $${excessLiabilitiesAtBlock200}, adding block delay of ${blockDelay}.`
            );
            canFillWithSafeHF = true;
            continue;
          } else if (adjustedFillPercent < fillPercent) {
            fillPercent = adjustedFillPercent;
            logger.info(
              `Unable to fill auction at 100% due to insufficient health factor. Auction fill exceeds HF borrow limit by $${limitToHF}. Dropping fill percent to ${fillPercent}.`
            );
          } else {
            canFillWithSafeHF = true;
            continue;
          }
        } else {
          canFillWithSafeHF = true;
          continue;
        }
      } else {
        canFillWithSafeHF = true;
        continue;
      }
    }
    if (!canFillWithSafeHF) {
      logger.error(`Unable to determine auction fill with a safe HF.`);
      throw new Error('Unable to determine auction fill with a safe HF.');
    }
  }

  let requestType: RequestType = RequestType.FillUserLiquidationAuction;
  switch (scaledAuction.type) {
    case AuctionType.Liquidation:
      requestType = RequestType.FillUserLiquidationAuction;
      break;
    case AuctionType.Interest:
      requestType = RequestType.FillInterestAuction;
      break;
    case AuctionType.BadDebt:
      requestType = RequestType.FillBadDebtAuction;
      break;
  }
  // push the fill request on the front of the list
  requests.unshift({
    request_type: requestType,
    address: auction.user,
    amount: BigInt(fillPercent),
  });

  bidScalar = fillBlockDelay <= 200 ? 1 : 1 - Math.max(0, fillBlockDelay - 200) / 200;
  lotScalar = fillBlockDelay < 200 ? fillBlockDelay / 200 : 1;
  return {
    block: auction.data.block + fillBlockDelay,
    percent: fillPercent,
    requests,
    lotValue: lotValue * lotScalar * (fillPercent / 100),
    bidValue: bidValue * bidScalar * (fillPercent / 100),
  };
}

/**
 * Calculate the effective collateral, lot value, effective liabilities, and bid value for an auction.
 *
 * @param auction - The auction to calculate the values for
 * @param pool - The pool to use for fetching reserve data
 * @param poolOracle - The pool oracle to use for fetching asset prices
 * @param sorobanHelper - A helper to use for loading ledger data
 * @param db - The database to use for fetching asset prices
 * @returns The calculated values, or 0 for all values if it is unable to calculate them
 */
export async function calculateAuctionValue(
  auction: Auction,
  pool: Pool,
  poolOracle: PoolOracle,
  sorobanHelper: SorobanHelper,
  db: AuctioneerDatabase
): Promise<AuctionValue> {
  let effectiveCollateral = 0;
  let lotValue = 0;
  let effectiveLiabilities = 0;
  let bidValue = 0;
  const reserves = pool.reserves;
  for (const [assetId, amount] of auction.data.lot) {
    if (auction.type === AuctionType.Liquidation || auction.type === AuctionType.Interest) {
      const reserve = reserves.get(assetId);
      if (reserve === undefined) {
        throw new Error(`Unexpected auction. Lot contains asset that is not a reserve: ${assetId}`);
      }
      const oraclePrice = poolOracle.getPriceFloat(assetId);
      const dbPrice = db.getPriceEntry(assetId)?.price;
      if (oraclePrice === undefined) {
        throw new Error(`Failed to get oracle price for asset: ${assetId}`);
      }
      if (auction.type === AuctionType.Liquidation) {
        // liquidation auction lots are in bTokens
        effectiveCollateral += reserve.toEffectiveAssetFromBTokenFloat(amount) * oraclePrice;
        lotValue += reserve.toAssetFromBTokenFloat(amount) * (dbPrice ?? oraclePrice);
      } else {
        lotValue += FixedMath.toFloat(amount, reserve.config.decimals) * (dbPrice ?? oraclePrice);
      }
    } else if (auction.type === AuctionType.BadDebt) {
      if (assetId !== APP_CONFIG.backstopTokenAddress) {
        throw new Error(
          `Unexpected bad debt auction. Lot contains asset other than the backstop token: ${assetId}`
        );
      }
      const lpTokenValue = await sorobanHelper.simLPTokensToUSDC(amount);
      if (lpTokenValue !== undefined) {
        lotValue += FixedMath.toFloat(lpTokenValue, 7);
      } else {
        // assume 2% slippage on spot price
        const backstopToken = await sorobanHelper.loadBackstopToken();
        lotValue += FixedMath.toFloat(amount, 7) * (backstopToken.lpTokenPrice * 0.98);
      }
    } else {
      throw new Error(`Failed to value lot asset: ${assetId}`);
    }
  }

  for (const [assetId, amount] of auction.data.bid) {
    if (auction.type === AuctionType.Liquidation || auction.type === AuctionType.BadDebt) {
      const reserve = reserves.get(assetId);
      if (reserve === undefined) {
        throw new Error(`Unexpected auction. Bid contains asset that is not a reserve: ${assetId}`);
      }
      const dbPrice = db.getPriceEntry(assetId)?.price;
      const oraclePrice = poolOracle.getPriceFloat(assetId);
      if (oraclePrice === undefined) {
        throw new Error(`Failed to get oracle price for asset: ${assetId}`);
      }
      effectiveLiabilities += reserve.toEffectiveAssetFromDTokenFloat(amount) * oraclePrice;
      bidValue += reserve.toAssetFromDTokenFloat(amount) * (dbPrice ?? oraclePrice);
    } else if (auction.type === AuctionType.Interest) {
      if (assetId !== APP_CONFIG.backstopTokenAddress) {
        throw new Error(
          `Unexpected interest auction. Bid contains asset other than the backstop token: ${assetId}`
        );
      }
      const lpTokenValue = await sorobanHelper.simLPTokensGetUSDCIn(amount);
      if (lpTokenValue !== undefined) {
        bidValue += FixedMath.toFloat(lpTokenValue, 7);
      } else {
        // assume 2% slippage on deposit
        const backstopToken = await sorobanHelper.loadBackstopToken();
        bidValue += FixedMath.toFloat(amount, 7) * (backstopToken.lpTokenPrice * 1.02);
      }
    } else {
      throw new Error(`Failed to value bid asset: ${assetId}`);
    }
  }

  return { effectiveCollateral, effectiveLiabilities, lotValue, bidValue };
}
