import { PoolUser, Positions, PositionsEstimate } from '@blend-capital/blend-sdk';
import { addUsersWithBorrows, updateUser } from '../src/user.js';
import { AuctioneerDatabase, UserEntry } from '../src/utils/db.js';
import { inMemoryAuctioneerDb, mockPool } from './helpers/mocks.js';
import { SorobanHelper } from '../src/utils/soroban_helper.js';
import { Keypair } from '@stellar/stellar-sdk';
import { DuneClient } from '@duneanalytics/client-sdk';
jest.mock('../src/utils/soroban_helper.js');
jest.mock('@duneanalytics/client-sdk');

jest.mock('../src/utils/config.js', () => {
  return {
    APP_CONFIG: {
      duneApiKey: 'key',
    },
  };
});
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
    updateUser(db, mockPool, user, user_estimate);

    let user_entry = db.getUserEntry('GPUBKEY1');
    expect(user_entry).toBeDefined();
    expect(user_entry?.user_id).toEqual('GPUBKEY1');
    expect(user_entry?.health_factor).toEqual(2);
    expect(user_entry?.liabilities.size).toEqual(2);
    expect(user_entry?.liabilities.get(mockPool.config.reserveList[0])).toEqual(BigInt(12345));
    expect(user_entry?.liabilities.get(mockPool.config.reserveList[1])).toEqual(BigInt(54321));
    expect(user_entry?.collateral.size).toEqual(1);
    expect(user_entry?.collateral.get(mockPool.config.reserveList[3])).toEqual(BigInt(789));
    expect(user_entry?.updated).toEqual(mockPool.config.latestLedger);
  });

  it('deletes existing user without liabilities', async () => {
    let user_entry: UserEntry = {
      user_id: 'GPUBKEY1',
      health_factor: 2,
      collateral: new Map([[mockPool.config.reserveList[3], BigInt(789)]]),
      liabilities: new Map([[mockPool.config.reserveList[2], BigInt(789)]]),
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
    updateUser(db, mockPool, user, user_estimate);

    let new_user_entry = db.getUserEntry('GPUBKEY1');
    expect(new_user_entry).toBeUndefined();
  });
});

describe('addUsersWithBorrows', () => {
  let db: AuctioneerDatabase;
  let mockedSorobanHelper: jest.Mocked<SorobanHelper>;
  let mockedDuneClientConstructor: jest.MockedClass<typeof DuneClient>;
  let mockedDuneClient: jest.Mocked<DuneClient>;
  let userInDB: PoolUser;
  let userInDbEstimate: PositionsEstimate;

  let userNotInDB: PoolUser;
  let userNotInDbEstimate: PositionsEstimate;
  beforeEach(() => {
    db = inMemoryAuctioneerDb();
    mockedSorobanHelper = new SorobanHelper() as jest.Mocked<SorobanHelper>;
    mockedDuneClientConstructor = DuneClient as jest.MockedClass<typeof DuneClient>;
    mockedDuneClient = new DuneClient('key') as jest.Mocked<DuneClient>;
  });

  it('correctly add missing user to db', async () => {
    userInDbEstimate = new PositionsEstimate(100, 200, 50, 100, 0, 0, 0, 0, 0);
    userInDB = new PoolUser(
      Keypair.random().publicKey(),
      new Positions(new Map(), new Map(), new Map()),
      new Map()
    );
    userNotInDbEstimate = new PositionsEstimate(100, 200, 50, 100, 0, 0, 0, 0, 0);
    userNotInDB = new PoolUser(
      Keypair.random().publicKey(),
      new Positions(new Map([[1, 200n]]), new Map([[2, 300n]]), new Map()),
      new Map()
    );

    db.setUserEntry({
      user_id: userInDB.userId,
      health_factor:
        userInDbEstimate.totalEffectiveCollateral / userInDbEstimate.totalEffectiveLiabilities,
      collateral: new Map(),
      liabilities: new Map(),
      updated: 123,
    });

    mockedSorobanHelper.loadUserPositionEstimate.mockResolvedValue({
      estimate: userNotInDbEstimate,
      user: userNotInDB,
    });
    mockedSorobanHelper.loadPool.mockResolvedValue(mockPool);
    mockedSorobanHelper.loadLatestLedger.mockResolvedValue(123);
    mockedDuneClient.getLatestResult.mockResolvedValue({
      result: {
        rows: [{ wallet: userNotInDB.userId }],
      },
    } as any);
    mockedDuneClientConstructor.mockImplementation(() => mockedDuneClient);

    await addUsersWithBorrows(db, mockedSorobanHelper);
    let userEntry = db.getUserEntry(userNotInDB.userId);
    expect(userEntry).toBeDefined();
  });

  it('expect existing user to not be updated', async () => {
    userInDbEstimate = new PositionsEstimate(100, 200, 50, 100, 0, 0, 0, 0, 0);
    userInDB = new PoolUser(
      Keypair.random().publicKey(),
      new Positions(new Map(), new Map(), new Map()),
      new Map()
    );
    userNotInDbEstimate = new PositionsEstimate(100, 200, 50, 100, 0, 0, 0, 0, 0);
    userNotInDB = new PoolUser(
      Keypair.random().publicKey(),
      new Positions(new Map([[1, 200n]]), new Map([[2, 300n]]), new Map()),
      new Map()
    );

    db.setUserEntry({
      user_id: userInDB.userId,
      health_factor:
        userInDbEstimate.totalEffectiveCollateral / userInDbEstimate.totalEffectiveLiabilities,
      collateral: new Map(),
      liabilities: new Map(),
      updated: 123,
    });

    mockedSorobanHelper.loadUserPositionEstimate.mockResolvedValue({
      estimate: userNotInDbEstimate,
      user: userNotInDB,
    });
    mockedSorobanHelper.loadPool.mockResolvedValue(mockPool);
    mockedSorobanHelper.loadLatestLedger.mockResolvedValue(200);
    mockedDuneClient.getLatestResult.mockResolvedValue({
      result: {
        rows: [{ wallet: userInDB.userId }],
      },
    } as any);
    mockedDuneClientConstructor.mockImplementation(() => mockedDuneClient);

    await addUsersWithBorrows(db, mockedSorobanHelper);
    let userEntry = db.getUserEntry(userInDB.userId);
    expect(userEntry).toBeDefined();
    expect(userEntry?.updated).toEqual(123);
  });

  it('expects users with no liabilites to be ignored', async () => {
    userInDbEstimate = new PositionsEstimate(100, 200, 50, 100, 0, 0, 0, 0, 0);
    userInDB = new PoolUser(
      Keypair.random().publicKey(),
      new Positions(new Map(), new Map(), new Map()),
      new Map()
    );
    userNotInDbEstimate = new PositionsEstimate(0, 200, 0, 100, 0, 0, 0, 0, 0);
    // Liability exists here because updateUser() requires it to be added
    userNotInDB = new PoolUser(
      Keypair.random().publicKey(),
      new Positions(new Map([[1, 200n]]), new Map(), new Map()),
      new Map()
    );

    db.setUserEntry({
      user_id: userInDB.userId,
      health_factor:
        userInDbEstimate.totalEffectiveCollateral / userInDbEstimate.totalEffectiveLiabilities,
      collateral: new Map(),
      liabilities: new Map(),
      updated: 123,
    });

    mockedSorobanHelper.loadUserPositionEstimate.mockResolvedValue({
      estimate: userNotInDbEstimate,
      user: userNotInDB,
    });
    mockedSorobanHelper.loadPool.mockResolvedValue(mockPool);
    mockedSorobanHelper.loadLatestLedger.mockResolvedValue(123);
    mockedDuneClient.getLatestResult.mockResolvedValue({
      result: {
        rows: [{ wallet: userNotInDB.userId }],
      },
    } as any);
    mockedDuneClientConstructor.mockImplementation(() => mockedDuneClient);

    await addUsersWithBorrows(db, mockedSorobanHelper);
    let userEntry = db.getUserEntry(userNotInDB.userId);
    expect(userEntry).toBeUndefined();
  });
});
