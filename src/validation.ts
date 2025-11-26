import { APP_CONFIG } from './utils/config.js';
import { SorobanHelper } from './utils/soroban_helper.js';

/**
 * Validates that the bot is mostly correctly configured. Attempts to catch any common misconfigurations
 * and error out if found to ensure the bot does not run in a broken state.
 *
 * @param sorobanHelper
 *
 * @throws Will throw an error if validation fails.
 */
export async function validateBot(sorobanHelper: SorobanHelper): Promise<void> {
  // validate the worker and filler keypairs are not the same
  if (APP_CONFIG.workerKeypair.publicKey() === APP_CONFIG.fillerKeypair.publicKey()) {
    throw new Error('Worker and filler keypairs must be different');
  }

  // validate the interest filler is a valid address and the auctioneer is the owner
  const owner = await sorobanHelper.simInterestFillerOwner();
  if (owner !== APP_CONFIG.fillerKeypair.publicKey()) {
    throw new Error(
      `Interest filler contract owner mismatch. Expected: ${APP_CONFIG.fillerKeypair.publicKey()}, Got: ${owner}`
    );
  }

  // validate the backstop token loads correctly
  await sorobanHelper.loadBackstopToken();

  // validate each pool loads and that each pool has the same backstop
  for (const poolConfig of APP_CONFIG.pools) {
    const pool = await sorobanHelper.loadPool(poolConfig.poolAddress);
    if (pool.metadata.backstop !== APP_CONFIG.backstopAddress) {
      throw new Error(
        `Pool backstop mismatch for pool ${pool.id}. Expected: ${APP_CONFIG.backstopTokenAddress}, Got: ${pool.metadata.backstop}`
      );
    }
  }
}
