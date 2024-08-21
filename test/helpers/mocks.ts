import { Pool, PoolUserEmissionData, Reserve } from '@blend-capital/blend-sdk';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { AuctioneerDatabase } from '../../src/utils/db';
import { parse } from '../../src/utils/json';

const mockPoolPath = path.resolve(__dirname, 'mock-pool.json');
let pool = parse<Pool>(fs.readFileSync(mockPoolPath, 'utf8'));
pool.reserves.forEach((reserve, assetId, map) => {
  map.set(
    assetId,
    new Reserve(
      assetId,
      reserve.tokenMetadata,
      reserve.poolBalance,
      reserve.config,
      reserve.data,
      reserve.borrowEmissions,
      reserve.supplyEmissions,
      reserve.oraclePrice,
      reserve.estimates,
      reserve.latestLedger
    )
  );
});
export let mockedPool = pool;

export let mockedFillerState = {
  user: '',
  positions: {
    liabilities: new Map<number, bigint>(),
    collateral: new Map<number, bigint>(),
    supply: new Map<number, bigint>(),
  },
  emissions: new Map<number, PoolUserEmissionData>(),
  positionEstimates: {
    liabilities: new Map<string, number>(),
    collateral: new Map<string, number>(),
    supply: new Map<string, number>(),
    totalBorrowed: 0,
    totalSupplied: 0,
    totalEffectiveLiabilities: 1000,
    totalEffectiveCollateral: 25000,
    borrowCap: 0,
    borrowLimit: 0,
    netApr: 0,
    supplyApr: 0,

    borrowApr: 0,
  },
  emissionEstimates: {} as any,
  latestLedger: 0,
};

export function inMemoryAuctioneerDb(): AuctioneerDatabase {
  let db = new Database(':memory:');
  db.exec(fs.readFileSync(path.resolve(__dirname, '../../init_db.sql'), 'utf8'));
  return new AuctioneerDatabase(db);
}
