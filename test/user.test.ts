import { PoolUser, Positions, PositionsEstimate } from '@blend-capital/blend-sdk';
import { updateUser } from '../src/user.js';
import { AuctioneerDatabase, UserEntry } from '../src/utils/db.js';
import { inMemoryAuctioneerDb, mockedPool } from './helpers/mocks.js';

describe('updateUser', () => {
  let db: AuctioneerDatabase;

  beforeEach(() => {
    db = inMemoryAuctioneerDb();
  });

  it('stores user data into db', async () => {
    let user_estimate = {
      totalEffectiveCollateral: 2000,
      totalEffectiveLiabilities: 1000,
    } as PositionsEstimate;
    let user = new PoolUser(
      'GPUBKEY1',
      new Positions(
        new Map([
          [0, BigInt(12345)],
          [1, BigInt(54321)],
        ]),
        new Map([[3, BigInt(789)]]),
        new Map()
      ),
      new Map()
    );
    updateUser(db, mockedPool, user, user_estimate);

    let user_entry = db.getUserEntry('GPUBKEY1');
    expect(user_entry).toBeDefined();
    expect(user_entry?.user_id).toEqual('GPUBKEY1');
    expect(user_entry?.health_factor).toEqual(2);
    expect(user_entry?.liabilities.size).toEqual(2);
    expect(user_entry?.liabilities.get(mockedPool.config.reserveList[0])).toEqual(BigInt(12345));
    expect(user_entry?.liabilities.get(mockedPool.config.reserveList[1])).toEqual(BigInt(54321));
    expect(user_entry?.collateral.size).toEqual(1);
    expect(user_entry?.collateral.get(mockedPool.config.reserveList[3])).toEqual(BigInt(789));
    expect(user_entry?.updated).toEqual(mockedPool.config.latestLedger);
  });

  it('deletes existing user without liabilities', async () => {
    let user_entry: UserEntry = {
      user_id: 'GPUBKEY1',
      health_factor: 2,
      collateral: new Map([[mockedPool.config.reserveList[3], BigInt(789)]]),
      liabilities: new Map([[mockedPool.config.reserveList[2], BigInt(789)]]),
      updated: 123,
    };
    db.setUserEntry(user_entry);

    let user_estimate = {
      totalEffectiveCollateral: 2000,
      totalEffectiveLiabilities: 1000,
    } as PositionsEstimate;
    let user = new PoolUser(
      'GPUBKEY1',
      new Positions(new Map(), new Map([[3, BigInt(789)]]), new Map([[2, BigInt(111)]])),
      new Map()
    );
    updateUser(db, mockedPool, user, user_estimate);

    let new_user_entry = db.getUserEntry('GPUBKEY1');
    expect(new_user_entry).toBeUndefined();
  });
});
