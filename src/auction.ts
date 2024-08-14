import { AuctionData, BackstopToken, Reserve } from '@blend-capital/blend-sdk';
import { Filler } from './utils/config.js';
import { SorobanHelper } from './utils/soroban_helper.js';
import { AuctionType } from './utils/db.js';
import { APP_CONFIG } from './utils/config.js';
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
      let lpTokenValue = await sorobanHelper.simLPTokenToUSDC(Number(amount));
      if (lpTokenValue !== undefined) {
        lotValue += lpTokenValue;
      }
      // Approximate the value of the comet tokens if simulation fails
      else {
        let backstopToken = await sorobanHelper.loadBackstopToken();
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
      let lpTokenValue = await sorobanHelper.simLPTokenToUSDC(Number(amount));
      if (lpTokenValue !== undefined) {
        bidValue += lpTokenValue;
      } else {
        let backstopToken = await sorobanHelper.loadBackstopToken();
        bidValue += (Number(amount) * backstopToken.lpTokenPrice) / 1e7;
      }
    }
  }

  const fillerState = await sorobanHelper.loadUser(filler.keypair.publicKey());
  let fillBlock = 0;
  let fillPercent = 100;

  if (lotValue >= bidValue * (1 + filler.minProfitPct)) {
    const minLotAmount = bidValue * (1 + filler.minProfitPct);
    effectiveCollateral = effectiveCollateral * (minLotAmount / lotValue);
    fillBlock = 200 - (lotValue - minLotAmount) / (lotValue / 200);
  } else {
    const maxBidAmount = lotValue * (1 - filler.minProfitPct);
    effectiveLiabilities = effectiveLiabilities * (maxBidAmount / bidValue);
    fillBlock = 200 + (bidValue - maxBidAmount) / (bidValue / 200);
  }
  fillBlock = Math.min(Math.max(Math.ceil(fillBlock), 0), 400);

  if (effectiveCollateral < effectiveLiabilities) {
    let additionalLiabilities = effectiveLiabilities - effectiveCollateral;
    let maxAdditionalLiabilities =
      (fillerState.positionEstimates.totalEffectiveCollateral -
        filler.minHealthFactor * fillerState.positionEstimates.totalEffectiveLiabilities) /
      filler.minHealthFactor;
    if (additionalLiabilities > maxAdditionalLiabilities) {
      fillPercent = Math.min(
        fillPercent,
        Math.floor((maxAdditionalLiabilities / additionalLiabilities) * 100)
      );
    }
  }

  // If bid contain comets lp tokens check the balance of fillers comet lp tokens and adjust fill percent
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
      fillPercent = Math.min(fillPercent, Math.floor((cometLpTokenBalance / cometLpBid) * 100));
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
  for (let [assetId, _] of auctionData.lot) {
    if (!filler.supportedLot.some((address) => assetId === address)) {
      return false;
    }
  }
  // validate bid
  for (let [assetId, _] of auctionData.bid) {
    if (!filler.supportedBid.some((address) => assetId === address)) {
      return false;
    }
  }
  return true;
}
