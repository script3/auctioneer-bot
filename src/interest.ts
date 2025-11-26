import { SorobanHelper } from './utils/soroban_helper.js';
import { WorkSubmission, WorkSubmissionType } from './work_submitter.js';
import { logger } from './utils/logger.js';
import { FixedMath, AuctionType } from '@blend-capital/blend-sdk';
import { checkFillerSupport } from './filler.js';
import { APP_CONFIG, PoolConfig } from './utils/config.js';

export async function checkPoolForInterestAuction(
  sorobanHelper: SorobanHelper,
  poolConfig: PoolConfig
): Promise<WorkSubmission | undefined> {
  try {
    const pool = await sorobanHelper.loadPool(poolConfig.poolAddress);
    const poolOracle = await sorobanHelper.loadPoolOracle(poolConfig.poolAddress);

    // check if there is an existing interest auction
    const interestAuction = await sorobanHelper.loadAuction(
      pool.id,
      APP_CONFIG.backstopAddress,
      AuctionType.Interest
    );
    if (interestAuction !== undefined) {
      logger.info(`Interest auction already exists for pool ${pool.id}`);
      return undefined;
    }

    // use the pools max auction lot size or at most 3 lot assets
    let maxLotAssets = Math.min(pool.metadata.maxPositions - 1, 3);
    let totalInterest = 0;
    let lotAssets = [];
    let backstopCredit: [string, number][] = [];
    for (const [assetId, reserve] of pool.reserves) {
      const assetPrice = poolOracle.getPrice(assetId) ?? BigInt(0);
      const priceFloat = FixedMath.toFloat(assetPrice, poolOracle.decimals);
      const creditFloat = FixedMath.toFloat(reserve.data.backstopCredit, reserve.config.decimals);
      backstopCredit.push([assetId, priceFloat * creditFloat]);
    }
    // sort by highest backstop credit first
    backstopCredit.sort((a, b) => b[1] - a[1]);
    for (let i = 0; i < backstopCredit.length; i++) {
      const [assetId, credit] = backstopCredit[i];
      if (credit < 10 || i >= maxLotAssets) {
        break;
      }
      totalInterest += credit;
      lotAssets.push(assetId);
    }
    if (totalInterest > 300) {
      const bid = [APP_CONFIG.backstopTokenAddress];
      const lot = lotAssets;

      // validate the expected filler has enough backstop tokens to fill
      if (checkFillerSupport(poolConfig, bid, lot)) {
        // found a filler - ensure it has enough backstop tokens to make the auction
        const usdcBalance = await sorobanHelper.simBalance(
          APP_CONFIG.usdcAddress,
          APP_CONFIG.fillerKeypair.publicKey()
        );
        const bidValue = FixedMath.toFloat(usdcBalance);

        if (bidValue > totalInterest) {
          logger.info(
            `Creating backstop interest auction for pool ${pool.id}, value: ${totalInterest}, lot assets: ${lotAssets}`
          );
          return {
            type: WorkSubmissionType.AuctionCreation,
            poolId: pool.id,
            user: APP_CONFIG.backstopAddress,
            auctionType: AuctionType.Interest,
            auctionPercent: 100,
            bid: [APP_CONFIG.backstopTokenAddress],
            lot: lotAssets,
          };
        } else {
          const logMessage =
            `Filler does not have enough USDC to create backstop interest auction.\n` +
            `User: ${APP_CONFIG.fillerKeypair.publicKey()}\n` +
            `Balance: ${FixedMath.toFloat(usdcBalance)}\n` +
            `Required: ${totalInterest}`;
          logger.error(logMessage);
          return undefined;
        }
      }
    } else {
      logger.info(
        `No backstop interest auction needed for pool ${pool.id}, value: ${totalInterest}`
      );
      return undefined;
    }
  } catch (e) {
    logger.error(`Error checking backstop interest in pool ${poolConfig.poolAddress}: ${e}`);
    return undefined;
  }
}
