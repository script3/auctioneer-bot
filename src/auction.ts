import { AuctionData, Request, RequestType } from '@blend-capital/blend-sdk';
import { Filler } from './utils/config.js';
import { SorobanHelper } from './utils/soroban_helper.js';
import { AuctioneerDatabase, AuctionType } from './utils/db.js';
import { APP_CONFIG } from './utils/config.js';
import { AuctionBid } from './bidder_submitter.js';
import { Asset } from '@stellar/stellar-sdk';
import { logger } from './utils/logger.js';
interface FillCalculation {
  fillBlock: number;
  fillPercent: number;
}

interface AuctionValue {
  effectiveCollateral: number;
  effectiveLiabilities: number;
  lotValue: number;
  bidValue: number;
}

/**
 * Calculate the block fill and fill percent for a given auction.
 *
 * @param filler - The filler to calculate the block fill for
 * @param auctionType - The type of auction to calculate the block fill for
 * @param auctionData - The auction data to calculate the block fill for
 * @param sorobanHelper - The soroban helper to use for the calculation
 */
export async function calculateBlockFillAndPercent(
  filler: Filler,
  auctionType: AuctionType,
  auctionData: AuctionData,
  sorobanHelper: SorobanHelper,
  db: AuctioneerDatabase
): Promise<FillCalculation> {
  // Sum the effective collateral and lot value
  let { effectiveCollateral, effectiveLiabilities, lotValue, bidValue } =
    await calculateAuctionValue(auctionType, auctionData, sorobanHelper, db);

  let fillBlockDelay = 0;
  let fillPercent = 100;
  logger.info(
    `Auction Valuation: Effective Collateral: ${effectiveCollateral}, Effective Liabilities: ${effectiveLiabilities}, Lot Value: ${lotValue}, Bid Value: ${bidValue}`
  );
  if (lotValue >= bidValue * (1 + filler.minProfitPct)) {
    const minLotAmount = bidValue * (1 + filler.minProfitPct);
    fillBlockDelay = 200 - (lotValue - minLotAmount) / (lotValue / 200);
  } else {
    const maxBidAmount = lotValue * (1 - filler.minProfitPct);
    fillBlockDelay = 200 + (bidValue - maxBidAmount) / (bidValue / 200);
  }
  fillBlockDelay = Math.min(Math.max(Math.ceil(fillBlockDelay), 0), 400);

  // Ensure the filler can fully fill interest auctions
  if (auctionType === AuctionType.Interest) {
    const cometLpTokenBalance = await sorobanHelper.simBalance(
      APP_CONFIG.backstopTokenAddress,
      filler.keypair.publicKey()
    );
    const cometLpBid =
      fillBlockDelay <= 200
        ? Number(auctionData.bid.get(APP_CONFIG.backstopTokenAddress)!)
        : Number(auctionData.bid.get(APP_CONFIG.backstopTokenAddress)!) *
          (1 - (fillBlockDelay - 200) / 200);
    if (cometLpTokenBalance < cometLpBid) {
      const additionalCometLp = cometLpBid - cometLpTokenBalance;
      const bidStepSize = Number(auctionData.bid.get(APP_CONFIG.backstopTokenAddress)) / 200;

      if (additionalCometLp >= 0 && bidStepSize > 0) {
        fillBlockDelay += Math.ceil(additionalCometLp / bidStepSize);
        if (filler.forceFill) {
          fillBlockDelay = Math.min(fillBlockDelay, 375);
        }
      }
    }
  }
  // Ensure the filler can maintain their minimum health factor
  else {
    const { estimate: fillerPositionEstimates } = await sorobanHelper.loadUserPositionEstimate(
      filler.keypair.publicKey()
    );
    if (fillBlockDelay <= 200) {
      effectiveCollateral = effectiveCollateral * (fillBlockDelay / 200);
    } else {
      effectiveLiabilities = effectiveLiabilities * (1 - (fillBlockDelay - 200) / 200);
    }
    if (effectiveCollateral < effectiveLiabilities) {
      const excessLiabilities = effectiveLiabilities - effectiveCollateral;
      const liabilityLimitToHF =
        fillerPositionEstimates.totalEffectiveCollateral / filler.minHealthFactor -
        fillerPositionEstimates.totalEffectiveLiabilities;

      if (excessLiabilities > liabilityLimitToHF) {
        fillPercent = Math.min(
          fillPercent,
          Math.floor((liabilityLimitToHF / excessLiabilities) * 100)
        );
      }
    }
  }

  return { fillBlock: auctionData.block + fillBlockDelay, fillPercent };
}

/**
 * Check if the filler can bid on an auction.
 * @param filler - The filler to check
 * @param auctionData - The auction data for the auction
 * @returns A boolean indicating if the filler cares about the auction.
 */
export function canFillerBid(filler: Filler, auctionData: AuctionData): boolean {
  // validate lot
  for (const [assetId, _] of auctionData.lot) {
    if (!filler.supportedLot.some((address) => assetId === address)) {
      return false;
    }
  }
  // validate bid
  for (const [assetId, _] of auctionData.bid) {
    if (!filler.supportedBid.some((address) => assetId === address)) {
      return false;
    }
  }
  return true;
}

/**
 * Scale an auction to the block the auction is to be filled and the percent which will be filled.
 * @param auction - The auction to scale
 * @param fillBlock - The block to scale to
 * @param fillPercent - The percent to scale to
 * @returns The scaled auction
 */
export function scaleAuction(
  auction: AuctionData,
  fillBlock: number,
  fillPercent: number
): AuctionData {
  let scaledAuction: AuctionData = {
    block: fillBlock,
    bid: new Map(),
    lot: new Map(),
  };
  let lotModifier;
  let bidModifier;
  const fillBlockDelta = fillBlock - auction.block;
  if (fillBlockDelta <= 200) {
    lotModifier = fillBlockDelta / 200;
    bidModifier = 1;
  } else {
    lotModifier = 1;
    if (fillBlockDelta < 400) {
      bidModifier = 1 - (fillBlockDelta - 200) / 200;
    } else {
      bidModifier = 0;
    }
  }

  for (const [assetId, amount] of auction.lot) {
    const scaledLot = Math.floor((Number(amount) * lotModifier * fillPercent) / 100);
    if (scaledLot > 0) {
      scaledAuction.lot.set(assetId, BigInt(scaledLot));
    }
  }
  for (const [assetId, amount] of auction.bid) {
    const scaledBid = Math.ceil((Number(amount) * bidModifier * fillPercent) / 100);
    if (scaledBid > 0) {
      scaledAuction.bid.set(assetId, BigInt(scaledBid));
    }
  }
  return scaledAuction;
}

/**
 * Build requests to fill the auction and clear the filler's position.
 * @param auctionBid - The auction to build the fill requests for
 * @param auctionData - The auction data to build the fill requests for
 * @param fillPercent - The percent to fill the auction
 * @param sorobanHelper - The soroban helper to use for loading ledger data
 * @returns
 */
export async function buildFillRequests(
  auctionBid: AuctionBid,
  auctionData: AuctionData,
  fillPercent: number,
  sorobanHelper: SorobanHelper
): Promise<Request[]> {
  let fillRequests: Request[] = [];
  let requestType: RequestType;
  switch (auctionBid.auctionEntry.auction_type) {
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
  fillRequests.push({
    request_type: requestType,
    address: auctionBid.auctionEntry.user_id,
    amount: BigInt(fillPercent),
  });

  const poolOracle = await sorobanHelper.loadPoolOracle();
  // Interest auctions transfer underlying assets
  if (auctionBid.auctionEntry.auction_type !== AuctionType.Interest) {
    let { estimate: fillerPositionEstimates, user: fillerPositions } =
      await sorobanHelper.loadUserPositionEstimate(auctionBid.auctionEntry.filler);
    const reserves = (await sorobanHelper.loadPool()).reserves;

    for (const [assetId, amount] of auctionData.bid) {
      const oraclePrice = poolOracle.getPriceFloat(assetId);
      // Skip assets without an oracle price
      if (oraclePrice === undefined) {
        continue;
      }
      const reserve = reserves.get(assetId);
      let fillerBalance = await sorobanHelper.simBalance(assetId, auctionBid.auctionEntry.filler);

      // Ensure the filler has XLM to pay for the transaction
      if (assetId === Asset.native().contractId(APP_CONFIG.networkPassphrase)) {
        fillerBalance = fillerBalance > 100 * 1e7 ? fillerBalance - 100 * 1e7 : 0;
      }
      if (reserve !== undefined && fillerBalance > 0) {
        const liabilityLeft = Math.max(0, Number(amount) - fillerBalance);
        const effectiveLiabilityIncrease =
          reserve.toEffectiveAssetFromDTokenFloat(BigInt(liabilityLeft)) * oraclePrice;
        fillerPositionEstimates.totalEffectiveLiabilities += effectiveLiabilityIncrease;
        fillRequests.push({
          request_type: RequestType.Repay,
          address: assetId,
          amount: BigInt(fillerBalance),
        });
      }
    }

    for (const [assetId, amount] of auctionData.lot) {
      const reserve = reserves.get(assetId);
      const oraclePrice = poolOracle.getPriceFloat(assetId);
      if (
        reserve !== undefined &&
        !fillerPositions.positions.collateral.has(reserve.config.index) &&
        oraclePrice !== undefined
      ) {
        const effectiveCollateralIncrease =
          reserve.toEffectiveAssetFromBTokenFloat(amount) * oraclePrice;
        const newHF =
          fillerPositionEstimates.totalEffectiveCollateral /
          fillerPositionEstimates.totalEffectiveLiabilities;
        if (newHF > auctionBid.filler.minHealthFactor) {
          fillRequests.push({
            request_type: RequestType.WithdrawCollateral,
            address: assetId,
            amount: BigInt(amount),
          });
        } else {
          fillerPositionEstimates.totalEffectiveCollateral += effectiveCollateralIncrease;
        }
      }
    }
  }
  return fillRequests;
}

/**
 * Calculate the effective collateral, lot value, effective liabilities, and bid value for an auction.
 * @param auctionType - The type of auction to calculate the values for
 * @param auctionData - The auction data to calculate the values for
 * @param sorobanHelper - A helper to use for loading ledger data
 * @param db - The database to use for fetching asset prices
 * @returns
 */
export async function calculateAuctionValue(
  auctionType: AuctionType,
  auctionData: AuctionData,
  sorobanHelper: SorobanHelper,
  db: AuctioneerDatabase
): Promise<AuctionValue> {
  let effectiveCollateral = 0;
  let lotValue = 0;
  let effectiveLiabilities = 0;
  let bidValue = 0;
  const reserves = (await sorobanHelper.loadPool()).reserves;
  const poolOracle = await sorobanHelper.loadPoolOracle();
  for (const [assetId, amount] of auctionData.lot) {
    const reserve = reserves.get(assetId);
    if (reserve !== undefined) {
      const oraclePrice = poolOracle.getPriceFloat(assetId);
      const dbPrice = db.getPriceEntry(assetId)?.price;
      if (oraclePrice === undefined) {
        throw new Error(`Failed to get oracle price for asset: ${assetId}`);
      }

      if (auctionType !== AuctionType.Interest) {
        effectiveCollateral += reserve.toEffectiveAssetFromBTokenFloat(amount) * oraclePrice;
        // TODO: change this to use the price in the db
        lotValue += reserve.toAssetFromBTokenFloat(amount) * (dbPrice ?? oraclePrice);
      }
      // Interest auctions are in underlying assets
      else {
        lotValue +=
          (Number(amount) / 10 ** reserve.tokenMetadata.decimals) * (dbPrice ?? oraclePrice);
      }
    } else if (assetId === APP_CONFIG.backstopTokenAddress) {
      // Simulate singled sided withdraw to USDC
      const lpTokenValue = await sorobanHelper.simLPTokenToUSDC(Number(amount));
      if (lpTokenValue !== undefined) {
        lotValue += lpTokenValue;
      }
      // Approximate the value of the comet tokens if simulation fails
      else {
        const backstopToken = await sorobanHelper.loadBackstopToken();
        lotValue += (Number(amount) * backstopToken.lpTokenPrice) / 1e7;
      }
    } else {
      throw new Error(`Failed to value lot asset: ${assetId}`);
    }
  }

  for (const [assetId, amount] of auctionData.bid) {
    const reserve = reserves.get(assetId);
    const dbPrice = db.getPriceEntry(assetId)?.price;

    if (reserve !== undefined) {
      const oraclePrice = poolOracle.getPriceFloat(assetId);
      if (oraclePrice === undefined) {
        throw new Error(`Failed to get oracle price for asset: ${assetId}`);
      }

      effectiveLiabilities += reserve.toEffectiveAssetFromDTokenFloat(amount) * oraclePrice;
      // TODO: change this to use the price in the db
      bidValue += reserve.toAssetFromDTokenFloat(amount) * (dbPrice ?? oraclePrice);
    } else if (assetId === APP_CONFIG.backstopTokenAddress) {
      // Simulate singled sided withdraw to USDC
      const lpTokenValue = await sorobanHelper.simLPTokenToUSDC(Number(amount));
      if (lpTokenValue !== undefined) {
        bidValue += lpTokenValue;
      } else {
        const backstopToken = await sorobanHelper.loadBackstopToken();
        bidValue += (Number(amount) * backstopToken.lpTokenPrice) / 1e7;
      }
    } else {
      throw new Error(`Failed to value bid asset: ${assetId}`);
    }
  }

  return { effectiveCollateral, effectiveLiabilities, lotValue, bidValue };
}
