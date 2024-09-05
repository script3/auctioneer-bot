import { Pool, PoolUser, PositionsEstimate } from '@blend-capital/blend-sdk';
import { AuctioneerDatabase, UserEntry } from './utils/db.js';
import { logger } from './utils/logger.js';

/**
 * Update a user in the database
 * @param db - The database
 * @param pool - The pool
 * @param user - The user to update
 * @param positionsEstimate - The positions estimate of the user
 * @param ledger - The ledger to update the user at. Defaults to the ledger the pool data was loaded at.
 * @returns void
 * @throws If unable to update the user in the DB
 */
export function updateUser(
  db: AuctioneerDatabase,
  pool: Pool,
  user: PoolUser,
  positionsEstimate: PositionsEstimate,
  ledger?: number | undefined
) {
  // TODO: Store latest ledger on Positions
  if (ledger === undefined) {
    ledger = pool.config.latestLedger;
  }

  if (user === undefined || positionsEstimate === undefined) {
    return;
  }

  if (user.positions.liabilities.size !== 0) {
    // user has liabilities, update db entry
    let collateralAddress = new Map<string, bigint>();
    for (let [assetIndex, amount] of user.positions.collateral) {
      const asset = pool.config.reserveList[assetIndex];
      collateralAddress.set(asset, amount);
    }
    let liabilitiesAddress = new Map<string, bigint>();
    for (let [assetIndex, amount] of user.positions.liabilities) {
      const asset = pool.config.reserveList[assetIndex];
      liabilitiesAddress.set(asset, amount);
    }
    const new_entry: UserEntry = {
      user_id: user.userId,
      health_factor:
        positionsEstimate.totalEffectiveCollateral / positionsEstimate.totalEffectiveLiabilities,
      collateral: collateralAddress,
      liabilities: liabilitiesAddress,
      updated: ledger,
    };
    db.setUserEntry(new_entry);
    logger.info(`Updated user entry for ${user.userId} at ledger ${ledger}.`);
  } else {
    // user does not have liabilities, remove db entry if it exists
    db.deleteUserEntry(user.userId);
    logger.info(
      `Deleted user entry for ${user.userId} at ledger ${ledger}, no liabilities remaining.`
    );
  }
}
