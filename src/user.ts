import { Pool, PoolUser, PositionsEstimate } from '@blend-capital/blend-sdk';
import { AuctioneerDatabase, UserEntry } from './utils/db.js';
import { logger } from './utils/logger.js';
import { APP_CONFIG } from './utils/config.js';
import { SorobanHelper } from './utils/soroban_helper.js';
import { DuneClient, ParameterType } from '@duneanalytics/client-sdk';

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
    logger.info(
      `Updated user entry for ${user.userId} at ledger ${ledger} with health factor: ${new_entry.health_factor}.`
    );
  } else {
    // user does not have liabilities, remove db entry if it exists
    db.deleteUserEntry(user.userId);
    logger.info(
      `Deleted user entry for ${user.userId} at ledger ${ledger}, no liabilities remaining.`
    );
  }
}

/**
 * Query dune for all borrows and add users with borrows to the database
 * @param db - The database
 * @param sorobanHelper - The soroban helper used for retrieving user positions
 */
export async function addUsersWithBorrows(db: AuctioneerDatabase, sorobanHelper: SorobanHelper) {
  try {
    if (APP_CONFIG.duneApiKey === undefined) {
      throw new Error('Dune API key not set.');
    }

    const duneClient = new DuneClient(APP_CONFIG.duneApiKey);
    let query_result = await duneClient.getLatestResult({
      queryId: 4370781,
      query_parameters: [
        {
          type: ParameterType.TEXT,
          value: APP_CONFIG.poolAddress,
          name: 'pool_id',
        },
      ],
    });

    const currLedger = await sorobanHelper.loadLatestLedger();
    const nextLedger = currLedger + 1;
    const borrowUsers: string[] = (query_result.result?.rows ?? []).map(
      (row) => row.wallet as string
    );

    const currentUsers = db.getUserEntriesUpdatedBefore(nextLedger).map((entry) => entry.user_id);
    const missingUsers = borrowUsers.filter((user) => !currentUsers.includes(user));
    let usersAdded = 0;
    for (const user of missingUsers) {
      const { estimate: userPositionsEstimate, user: userPositions } =
        await sorobanHelper.loadUserPositionEstimate(user);
      if (userPositionsEstimate.totalEffectiveLiabilities > 0) {
        updateUser(
          db,
          await sorobanHelper.loadPool(),
          userPositions,
          userPositionsEstimate,
          currLedger
        );
        usersAdded++;
      }
    }
    logger.info(`Added ${usersAdded} users with borrows to the database.`);
  } catch (e) {
    logger.error(`Error catching up users with borrows: ${e}`);
  }
}
