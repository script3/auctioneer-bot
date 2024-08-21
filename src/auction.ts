import { AuctionData, Request, RequestType } from '@blend-capital/blend-sdk';
import { Filler } from './utils/config.js';
import { SorobanHelper } from './utils/soroban_helper.js';
import { AuctionType } from './utils/db.js';
import { APP_CONFIG } from './utils/config.js';
import { AuctionBid } from './bidder_submitter.js';
import { Asset } from '@stellar/stellar-sdk';
interface FillCalculation {
  fillBlock: number;
  fillPercent: number;
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
  sorobanHelper: SorobanHelper
): Promise<FillCalculation> {
  // Represents the effective collateral and liabilities of the auction for health factor calculation
  let effectiveCollateral = 0;
  let effectiveLiabilities = 0;
  // Represents the value of the lot and bid for profit calculation
  let lotValue = 0;
  let bidValue = 0;
  const reserves = (await sorobanHelper.loadPool()).reserves;

  // Sum the effective collateral and lot value
  for (const [assetId, amount] of auctionData.lot) {
    const reserve = reserves.get(assetId);
    if (reserve !== undefined) {
      if (auctionType !== AuctionType.Interest) {
        effectiveCollateral += reserve.toEffectiveAssetFromBToken(amount) * reserve.oraclePrice;
        lotValue += reserve.toAssetFromBToken(amount) * reserve.oraclePrice;
      }
      // Interest auctions are in underlying assets
      else {
        lotValue += (Number(amount) / 10 ** reserve.config.decimals) * reserve.oraclePrice;
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
    }
  }
  // Sum the effective liabilities and bid value
  for (const [assetId, amount] of auctionData.bid) {
    const reserve = reserves.get(assetId);
    if (reserve !== undefined) {
      effectiveLiabilities += reserve.toEffectiveAssetFromDToken(amount) * reserve.oraclePrice;
      bidValue += reserve.toAssetFromDToken(amount) * reserve.oraclePrice;
    } else if (assetId === APP_CONFIG.backstopTokenAddress) {
      // Simulate singled sided withdraw to USDC
      const lpTokenValue = await sorobanHelper.simLPTokenToUSDC(Number(amount));
      if (lpTokenValue !== undefined) {
        bidValue += lpTokenValue;
      } else {
        const backstopToken = await sorobanHelper.loadBackstopToken();
        bidValue += (Number(amount) * backstopToken.lpTokenPrice) / 1e7;
      }
    }
  }

  let fillBlock = 0;
  let fillPercent = 100;

  if (lotValue >= bidValue * (1 + filler.minProfitPct)) {
    const minLotAmount = bidValue * (1 + filler.minProfitPct);
    fillBlock = 200 - (lotValue - minLotAmount) / (lotValue / 200);
  } else {
    const maxBidAmount = lotValue * (1 - filler.minProfitPct);
    fillBlock = 200 + (bidValue - maxBidAmount) / (bidValue / 200);
  }
  fillBlock = Math.min(Math.max(Math.ceil(fillBlock), 0), 400);

  // Ensure the filler can fully fill interest auctions
  if (auctionType === AuctionType.Interest) {
    const cometLpTokenBalance = await sorobanHelper.simBalance(
      APP_CONFIG.backstopTokenAddress,
      filler.keypair.publicKey()
    );
    const cometLpBid =
      fillBlock <= 200
        ? Number(auctionData.bid.get(APP_CONFIG.backstopTokenAddress)!)
        : Number(auctionData.bid.get(APP_CONFIG.backstopTokenAddress)!) *
          (1 - (fillBlock - 200) / 200);
    if (cometLpTokenBalance < cometLpBid) {
      const additionalCometLp = cometLpBid - cometLpTokenBalance;
      const bidStepSize = Number(auctionData.bid.get(APP_CONFIG.backstopTokenAddress)) / 200;

      if (additionalCometLp >= 0 && bidStepSize > 0) {
        fillBlock += Math.ceil(additionalCometLp / bidStepSize);
        if (filler.forceFill) {
          fillBlock = Math.min(fillBlock, 375);
        }
      }
    }
  }
  // Ensure the filler can maintain their minimum health factor
  else {
    const fillerState = await sorobanHelper.loadUser(filler.keypair.publicKey());
    if (fillBlock <= 200) {
      effectiveCollateral = effectiveCollateral * (fillBlock / 200);
    } else {
      effectiveLiabilities = effectiveLiabilities * (1 - (fillBlock - 200) / 200);
    }
    if (effectiveCollateral < effectiveLiabilities) {
      const excessLiabilities = effectiveLiabilities - effectiveCollateral;
      const liabilityLimitToHF =
        fillerState.positionEstimates.totalEffectiveCollateral / filler.minHealthFactor -
        fillerState.positionEstimates.totalEffectiveLiabilities;

      if (excessLiabilities > liabilityLimitToHF) {
        fillPercent = Math.min(
          fillPercent,
          Math.floor((liabilityLimitToHF / excessLiabilities) * 100)
        );
      }
    }
  }

  return { fillBlock, fillPercent };
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
    block: auction.block + fillBlock,
    bid: new Map(),
    lot: new Map(),
  };
  let lotModifier;
  let bidModifier;
  if (fillBlock <= 200) {
    lotModifier = fillBlock / 200;
    bidModifier = 1;
  } else {
    lotModifier = 1;
    if (fillBlock < 400) {
      bidModifier = 1 - (fillBlock - 200) / 200;
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

  // Interest auctions transfer underlying assets
  if (auctionBid.auctionEntry.auction_type !== AuctionType.Interest) {
    let fillerState = await sorobanHelper.loadUser(auctionBid.auctionEntry.filler);
    const reserves = (await sorobanHelper.loadPool()).reserves;

    for (const [assetId, amount] of auctionData.bid) {
      const reserve = reserves.get(assetId);
      let fillerBalance = await sorobanHelper.simBalance(assetId, auctionBid.auctionEntry.filler);

      // Ensure the filler has XLM to pay for the transaction
      if (assetId === Asset.native().contractId(APP_CONFIG.networkPassphrase)) {
        fillerBalance = fillerBalance > 100 * 1e7 ? fillerBalance - 100 * 1e7 : 0;
      }
      if (reserve !== undefined && fillerBalance > 0) {
        const liabilityLeft = Math.max(0, Number(amount) - fillerBalance);
        const effectiveLiabilityIncrease =
          reserve.toEffectiveAssetFromDToken(BigInt(liabilityLeft)) * reserve.oraclePrice;
        fillerState.positionEstimates.totalEffectiveLiabilities += effectiveLiabilityIncrease;
        fillRequests.push({
          request_type: RequestType.Repay,
          address: assetId,
          amount: BigInt(fillerBalance),
        });
      }
    }

    for (const [assetId, amount] of auctionData.lot) {
      const reserve = reserves.get(assetId);

      if (reserve !== undefined && !fillerState.positions.collateral.has(reserve.config.index)) {
        const effectiveCollateralIncrease =
          reserve.toEffectiveAssetFromBToken(amount) * reserve.oraclePrice;
        const newHF =
          fillerState.positionEstimates.totalEffectiveCollateral /
          fillerState.positionEstimates.totalEffectiveLiabilities;
        if (newHF > auctionBid.filler.minHealthFactor) {
          fillRequests.push({
            request_type: RequestType.WithdrawCollateral,
            address: assetId,
            amount: BigInt(amount),
          });
        } else {
          fillerState.positionEstimates.totalEffectiveCollateral += effectiveCollateralIncrease;
        }
      }
    }
  }
  return fillRequests;
}
