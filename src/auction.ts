import { AuctionData, Backstop, BackstopToken, Reserve } from '@blend-capital/blend-sdk';
import { Filler } from './utils/db.js';
import { SorobanHelper } from './utils/soroban_helper.js';

interface FillCalculation {
  fillBlock: number;
  fillPercent: number;
}

/**
 * Calculate the block fill and fill percent for a given auction.
 *
 * @param filler - The filler to calculate the block fill for
 * @param auctionData - The auction data to calculate the block fill for
 * @param prices - The prices of the assets in the auction
 * @param sorobanHelper - The soroban helper to use for the calculation
 */
export async function calculateBlockFillAndPercent(
  filler: Filler,
  auctionData: AuctionData,
  prices: Map<string, number>,
  sorobanHelper: SorobanHelper
): Promise<FillCalculation> {
  // Represents the effective collateral and liabilities of the auction
  let effectiveCollateral = 0;
  let effectiveLiabilities = 0;
  // Represents the value of the lot and bid
  let lotValue = 0;
  let bidValue = 0;
  // Represents the value of the comet collateral and liabilities
  let cometCollateralValue = 0;
  let cometLiabilitiesValue = 0;
  const reserves = (await sorobanHelper.loadPool()).reserves;

  // Sum the effective collateral and liabilities and the value of the lot and bid
  for (const [assetId, amount] of auctionData.lot) {
    const reserve = reserves.get(assetId);
    if (reserve !== undefined) {
      effectiveCollateral += reserve.toEffectiveAssetFromBToken(amount) * reserve.oraclePrice;
      lotValue += reserve.toAssetFromBToken(amount) * (prices.get(assetId) ?? 0);
    } else if (assetId === sorobanHelper.cometId) {
      // Simulate singled sided withdraw to USDC
      let lpTokenValue = await sorobanHelper.simLPTokenToUSDC(Number(amount));
      if (lpTokenValue !== undefined) {
        cometCollateralValue += lpTokenValue;
      }
      // Approximate the value of the comet tokens if simulation fails
      else {
        let backstopToken = await BackstopToken.load(
          sorobanHelper.network,
          sorobanHelper.cometId,
          (await sorobanHelper.loadPool()).config.blndTkn,
          sorobanHelper.usdcId
        );
        cometCollateralValue += (Number(amount) * backstopToken.lpTokenPrice) / 1e7;
      }
    }
  }
  for (const [assetId, amount] of auctionData.bid) {
    const reserve = reserves.get(assetId);
    if (reserve !== undefined) {
      effectiveLiabilities += reserve.toEffectiveAssetFromDToken(amount) * reserve.oraclePrice;
      bidValue += reserve.toAssetFromDToken(amount) * (prices.get(assetId) ?? 0);
    } else if (assetId === sorobanHelper.cometId) {
      // Simulate singled sided withdraw to USDC
      let lpTokenValue = await sorobanHelper.simLPTokenToUSDC(Number(amount));
      if (lpTokenValue !== undefined) {
        cometLiabilitiesValue += lpTokenValue;
      } else {
        let backstopToken = await BackstopToken.load(
          sorobanHelper.network,
          sorobanHelper.cometId,
          (await sorobanHelper.loadPool()).config.blndTkn,
          sorobanHelper.usdcId
        );
        cometCollateralValue += (Number(amount) * backstopToken.lpTokenPrice) / 1e7;
      }
    }
  }
  lotValue += cometCollateralValue;
  bidValue += cometLiabilitiesValue;

  const fillerState = await sorobanHelper.loadUser(filler.keypair.publicKey());
  let fillBlock = 0;
  let fillPercent = 100;

  while (fillBlock < 400) {
    if (fillBlock <= 200) {
      let profit = lotValue * (fillBlock / 200) - bidValue;

      if (profit > filler.minProfitPct * bidValue) {
        // Calculate the new health factor
        let newHealthFactor =
          (fillerState.positionEstimates.totalEffectiveCollateral +
            effectiveCollateral * (fillBlock / 200)) /
          (fillerState.positionEstimates.totalEffectiveLiabilities + effectiveLiabilities);

        // Adjust the fill percent to maintain the health factor
        if (newHealthFactor < filler.minHealthFactor) {
          for (let percent = 99; percent > 0; percent--) {
            const adjustedFillHealthFactor =
              (fillerState.positionEstimates.totalEffectiveCollateral +
                (effectiveCollateral * (fillBlock / 200) * percent) / 100) /
              (fillerState.positionEstimates.totalEffectiveLiabilities +
                (effectiveLiabilities * percent) / 100);
            if (adjustedFillHealthFactor > filler.minHealthFactor) {
              fillPercent = percent;
              break;
            }
          }
        }
        break;
      }
      fillBlock++;
    } else {
      let profit = lotValue - bidValue * (1 - (fillBlock - 200) / 200);

      if (profit > filler.minProfitPct * bidValue) {
        // Calculate the new health factor
        let newHealthFactor =
          (fillerState.positionEstimates.totalEffectiveCollateral + effectiveCollateral) /
          (fillerState.positionEstimates.totalEffectiveLiabilities +
            effectiveLiabilities * (1 - (fillBlock - 200) / 200));

        // Adjust the fill percent to maintain the health factor
        if (newHealthFactor < filler.minHealthFactor) {
          for (let percent = 99; percent > 0; percent--) {
            const adjustedFillHealthFactor =
              (fillerState.positionEstimates.totalEffectiveCollateral +
                (effectiveCollateral * percent) / 100) /
              (fillerState.positionEstimates.totalEffectiveLiabilities +
                (effectiveLiabilities * (1 - (fillBlock - 200) / 200) * percent) / 100);
            if (adjustedFillHealthFactor > filler.minHealthFactor) {
              fillPercent = percent;
              break;
            }
          }
        }

        break;
      }
      fillBlock++;
    }
  }

  // If bid contain comets lp tokens check the balance of fillers comet lp tokens and adjust fill percent
  if (cometLiabilitiesValue > 0) {
    const cometLpTokenBalance = await sorobanHelper.getBalance(
      sorobanHelper.cometId,
      filler.keypair.publicKey()
    );
    if (cometLpTokenBalance < cometLiabilitiesValue) {
      fillPercent = Math.min(
        fillPercent,
        Math.floor((cometLpTokenBalance / cometLiabilitiesValue) * 100)
      );
    }
  }
  return { fillBlock, fillPercent };
}

export async function findFiller(
  fillers: Filler[],
  auctionData: AuctionData,
  sorobanHelper: SorobanHelper
): Promise<Filler | undefined> {
  // Find the filler with the highest health factor
  let bestFiller: Filler | undefined = undefined;
  let bestHealthFactor = 0;

  outerLoop: for (let filler of fillers) {
    for (let [asset, _] of auctionData.lot.entries()) {
      if (!filler.supportedLot.includes(asset) && asset !== sorobanHelper.cometId) {
        continue outerLoop;
      }
    }
    for (let [asset, _] of auctionData.bid.entries()) {
      if (!filler.supportedBid.includes(asset) && asset !== sorobanHelper.cometId) {
        continue outerLoop;
      }
    }
    let fillerState = await sorobanHelper.loadUser(filler.keypair.publicKey());

    // If auction bid contains blend lp tokens find the filler with the highest comet lp token balance
    if (auctionData.bid.get(sorobanHelper.cometId) !== undefined) {
      const cometLpTokenBalance = await sorobanHelper.getBalance(
        sorobanHelper.cometId,
        filler.keypair.publicKey()
      );
      let fillPercent = cometLpTokenBalance / Number(auctionData.bid.get(sorobanHelper.cometId));
      if (fillPercent > bestHealthFactor) {
        bestHealthFactor = fillPercent;
        bestFiller = filler;
      }
    } else {
      let healthFactor =
        fillerState.positionEstimates.totalEffectiveCollateral /
        fillerState.positionEstimates.totalEffectiveLiabilities;
      if (healthFactor > bestHealthFactor) {
        bestHealthFactor = healthFactor;
        bestFiller = filler;
      }
    }
  }
  return bestFiller;
}
