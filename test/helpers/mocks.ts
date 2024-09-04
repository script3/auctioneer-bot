import {
  Pool,
  PoolOracle,
  PoolUser,
  PoolUserEmissionData,
  PositionsEstimate,
  PriceData,
  Reserve,
} from '@blend-capital/blend-sdk';
import { Keypair } from '@stellar/stellar-sdk';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { AuctioneerDatabase } from '../../src/utils/db.js';
import { parse } from '../../src/utils/json.js';

const mockPoolPath = path.resolve(__dirname, 'mock-pool.json');
let pool = parse<Pool>(fs.readFileSync(mockPoolPath, 'utf8'));
pool.reserves.forEach((reserve, assetId, map) => {
  map.set(
    assetId,
    new Reserve(
      pool.id,
      assetId,
      reserve.tokenMetadata,
      reserve.config,
      reserve.data,
      reserve.borrowEmissions,
      reserve.supplyEmissions,
      reserve.borrowApr,
      reserve.supplyApr,
      reserve.latestLedger
    )
  );
});
export let mockedPool = pool;

export let mockedReserves = pool.config.reserveList;

export let mockPoolUser = new PoolUser(
  Keypair.random().publicKey(),
  {
    liabilities: new Map<number, bigint>(),
    collateral: new Map<number, bigint>(),
    supply: new Map<number, bigint>(),
  },
  new Map<number, PoolUserEmissionData>()
);

export let mockPoolOracle = new PoolOracle(
  'CATKK5ZNJCKQQWTUWIUFZMY6V6MOQUGSTFSXMNQZHVJHYF7GVV36FB3Y',
  new Map<string, PriceData>([
    [
      'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA',
      { price: BigInt(9899585234193), timestamp: 1724949300 },
    ],
    [
      'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
      { price: BigInt(99969142646062), timestamp: 1724949300 },
    ],
    [
      'CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV',
      { price: BigInt(109278286319197), timestamp: 1724949300 },
    ],
    [
      'CAUIKL3IYGMERDRUN6YSCLWVAKIFG5Q4YJHUKM4S4NJZQIA3BAS6OJPK',
      { price: BigInt(64116899991), timestamp: 1724950800 },
    ],
  ]),
  14,
  53255053
);

export let mockPoolUserEstimate: PositionsEstimate = {
  totalBorrowed: 0,
  totalSupplied: 0,
  totalEffectiveLiabilities: 1000,
  totalEffectiveCollateral: 25000,
  borrowCap: 0,
  borrowLimit: 0,
  netApr: 0,
  supplyApr: 0,
  borrowApr: 0,
};

export function inMemoryAuctioneerDb(): AuctioneerDatabase {
  let db = new Database(':memory:');
  db.exec(fs.readFileSync(path.resolve(__dirname, '../../init_db.sql'), 'utf8'));
  return new AuctioneerDatabase(db);
}
