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
 * @param reserves - The reserves to use for the calculation
 */
export async function calculateBlockFillAndPercent(
  filler: Filler,
  auctionData: AuctionData,
  reserves: Map<string, Reserve>,
  sorobanHelper: SorobanHelper
): Promise<FillCalculation> {
  let totalEffectiveCollateral = 0;
  let totalEffectiveLiabilities = 0;
  let cometCollateralValue = 0;
  let cometLiabilitiesValue = 0;
  // Sum the effective collateral and liabilities
  for (const [assetId, amount] of auctionData.lot) {
    let reserve = reserves.get(assetId);
    if (reserve !== undefined) {
      totalEffectiveCollateral += Number(amount * reserve.data.bRate);
    } else {
      // If the reserve does not exist, the asset is blend lp tokens
      // Simulate singled sided withdraw to USDC
      let backstopToken = await BackstopToken.load(
        sorobanHelper.network,
        sorobanHelper.cometId,
        (await sorobanHelper.loadPool()).config.blndTkn,
        sorobanHelper.usdcId
      );
      cometCollateralValue +=
        (await sorobanHelper.simLPTokenToUSDC(Number(amount))) ??
        (Number(amount) * backstopToken.usdcPerLpToken) / 1e7;
    }
  }
  for (const [assetId, amount] of auctionData.bid) {
    const reserve = reserves.get(assetId);
    if (reserve !== undefined) {
      totalEffectiveLiabilities += Number(amount * reserve.data.dRate);
    } else {
      // If the reserve does not exist, the asset is blend lp tokens
      // Simulate singled sided withdraw to USDC
      let backstopToken = await BackstopToken.load(
        sorobanHelper.network,
        sorobanHelper.cometId,
        (await sorobanHelper.loadPool()).config.blndTkn,
        sorobanHelper.usdcId
      );
      cometCollateralValue +=
        (await sorobanHelper.simLPTokenToUSDC(Number(amount))) ??
        (Number(amount) * backstopToken.usdcPerLpToken) / 1e7;
    }
  }
  const totalLotValue = totalEffectiveCollateral + cometCollateralValue;
  const totalBidValue = totalEffectiveLiabilities + cometLiabilitiesValue;

  // Calculate fillers health factor
  const pool = await sorobanHelper.loadPool();
  const fillerState = await sorobanHelper.loadUser(pool, filler.keypair.publicKey());
  let fillBlock = 0;
  let fillPercent = 100;

  while (fillBlock < 400) {
    if (fillBlock <= 200) {
      let profit = totalLotValue * (fillBlock / 200) - totalBidValue;

      if (profit > filler.minProfitPct * totalBidValue) {
        // Calculate the new health factor
        let newHealthFactor =
          (fillerState.positionEstimates.totalEffectiveCollateral +
            totalEffectiveCollateral * (fillBlock / 200)) /
          (fillerState.positionEstimates.totalEffectiveLiabilities + totalEffectiveLiabilities);

        // Adjust the fill percent to maintain the health factor
        if (newHealthFactor < filler.minHealthFactor) {
          for (let percent = 99; percent > 0; percent--) {
            const adjustedFillHealthFactor =
              (fillerState.positionEstimates.totalEffectiveCollateral +
                (totalEffectiveCollateral * (fillBlock / 200) * percent) / 100) /
              (fillerState.positionEstimates.totalEffectiveLiabilities +
                (totalEffectiveLiabilities * percent) / 100);
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
      let profit = totalLotValue - (totalBidValue * (fillBlock - 200)) / 200;

      if (profit > filler.minProfitPct * totalBidValue) {
        // Calculate the new health factor
        let newHealthFactor =
          (fillerState.positionEstimates.totalEffectiveCollateral + totalEffectiveCollateral) /
          (fillerState.positionEstimates.totalEffectiveLiabilities +
            (totalEffectiveLiabilities * (fillBlock - 200)) / 200);

        // Adjust the fill percent to maintain the health factor
        if (newHealthFactor < filler.minHealthFactor) {
          for (let percent = 99; percent > 0; percent--) {
            const adjustedFillHealthFactor =
              (fillerState.positionEstimates.totalEffectiveCollateral +
                (totalEffectiveCollateral * percent) / 100) /
              (fillerState.positionEstimates.totalEffectiveLiabilities +
                (((totalEffectiveLiabilities * (fillBlock - 200)) / 200) * percent) / 100);
            if (adjustedFillHealthFactor > filler.minHealthFactor) {
              fillPercent = percent;
              break;
            }
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
            break;
          }
        }
        break;
      }
      fillBlock++;
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
    let fillerState = await sorobanHelper.loadUser(
      await sorobanHelper.loadPool(),
      filler.keypair.publicKey()
    );

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
