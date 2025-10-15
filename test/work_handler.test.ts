import { PoolOracle, PoolUser, Positions, PositionsEstimate } from '@blend-capital/blend-sdk';
import { Keypair } from '@stellar/stellar-sdk';
import {
  AppEvent,
  EventType,
  LiqScanEvent,
  OracleScanEvent,
  UserRefreshEvent,
} from '../src/events';
import { checkUsersForLiquidationsAndBadDebt, scanUsers } from '../src/liquidations';
import { OracleHistory } from '../src/oracle_history';
import { AuctioneerDatabase, AuctionType, UserEntry } from '../src/utils/db';
import { SorobanHelper } from '../src/utils/soroban_helper';
import { WorkHandler } from '../src/work_handler';
import { WorkSubmission, WorkSubmissionType, WorkSubmitter } from '../src/work_submitter';
import { AppConfig, APP_CONFIG } from '../src/utils/config';
import { updateUser } from '../src/user';
import { sendNotification } from '../src/utils/notifier';
import { mockPool } from './helpers/mocks';

jest.mock('../src/work_submitter');
jest.mock('../src/oracle_history');
jest.mock('../src/utils/prices');
jest.mock('../src/liquidations');
jest.mock('../src/user');
jest.mock('../src/utils/messages');
jest.mock('../src/utils/notifier');
jest.mock('../src/utils/logger');
jest.mock('../src/utils/soroban_helper');
jest.mock('../src/utils/config.js', () => {
  let config: AppConfig = {
    pools: ['pool1', 'pool2'],
  } as AppConfig;
  return {
    APP_CONFIG: config,
  };
});

describe('WorkHandler', () => {
  let workHandler: WorkHandler;
  let mockedDb: jest.Mocked<AuctioneerDatabase>;
  let mockedSubmissionQueue = new WorkSubmitter() as jest.Mocked<WorkSubmitter>;
  let mockedOracleHistory = new OracleHistory(0.025) as jest.Mocked<OracleHistory>;
  let mockedSorobanHelper = new SorobanHelper() as jest.Mocked<SorobanHelper>;
  let mockedScanUsers = scanUsers as jest.MockedFunction<typeof scanUsers>;
  let pool_user: string;
  let estimate: PositionsEstimate;
  let user: PoolUser;
  const mockedDateNow = 1609459200000;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedDb = {
      getUserEntriesWithLiability: jest.fn(),
      getUserEntriesWithCollateral: jest.fn(),
      getUserEntriesUpdatedBefore: jest.fn(),
    } as unknown as jest.Mocked<AuctioneerDatabase>;
    workHandler = new WorkHandler(
      mockedDb,
      mockedSubmissionQueue,
      mockedOracleHistory,
      mockedSorobanHelper
    );

    Date.now = jest.fn(() => mockedDateNow);
    pool_user = Keypair.random().publicKey();
    estimate = {
      totalEffectiveCollateral: 2000,
      totalEffectiveLiabilities: 1000,
    } as PositionsEstimate;
    user = new PoolUser(
      pool_user,
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
    mockedSorobanHelper.loadUserPositionEstimate.mockResolvedValue({
      estimate: estimate,
      user,
    });
  });

  it('should handle ORACLE_SCAN event', async () => {
    const appEvent: AppEvent = {
      type: EventType.ORACLE_SCAN,
    } as OracleScanEvent;
    const poolOracle = new PoolOracle('', new Map(), 7, 0);
    const priceChanges = { up: ['asset1'], down: ['asset2'] };
    const usersWithLiability: UserEntry[] = [
      {
        pool_id: 'pool1',
        user_id: 'user1',
        health_factor: 0,
        collateral: new Map([['asset2', BigInt(100)]]),
        liabilities: new Map([['asset1', BigInt(50)]]),
        updated: 0,
      },
    ];
    const usersWithCollateral: UserEntry[] = [
      {
        pool_id: 'pool2',
        user_id: 'user1',
        health_factor: 0,
        collateral: new Map([['asset2', BigInt(100)]]),
        liabilities: new Map([['asset1', BigInt(50)]]),
        updated: 0,
      },
    ];
    const liquidations: WorkSubmission[] = [
      {
        poolId: APP_CONFIG.pools[0],
        user: 'user1',
        type: WorkSubmissionType.AuctionCreation,
        auctionType: AuctionType.Liquidation,
        bid: ['asset1'],
        lot: ['asset2'],
        auctionPercent: 10,
      },
      {
        poolId: APP_CONFIG.pools[1],
        user: 'user1',
        type: WorkSubmissionType.AuctionCreation,
        auctionType: AuctionType.Liquidation,
        bid: ['asset1'],
        lot: ['asset2'],
        auctionPercent: 10,
      },
    ];
    mockedSorobanHelper.loadPoolOracle.mockResolvedValue(poolOracle);
    mockedOracleHistory.getSignificantPriceChanges.mockReturnValue(priceChanges);
    mockedDb.getUserEntriesWithLiability.mockReturnValue(usersWithLiability);
    mockedDb.getUserEntriesWithCollateral.mockReturnValue(usersWithCollateral);
    (checkUsersForLiquidationsAndBadDebt as jest.Mock).mockResolvedValue(liquidations);

    await workHandler.processEvent(appEvent);
    expect(mockedOracleHistory.getSignificantPriceChanges).toHaveBeenCalledWith(poolOracle);
    for (const poolId of APP_CONFIG.pools) {
      expect(mockedSorobanHelper.loadPoolOracle).toHaveBeenCalledWith(poolId);
      expect(mockedDb.getUserEntriesWithLiability).toHaveBeenCalledWith(poolId, 'asset1');
      expect(mockedDb.getUserEntriesWithCollateral).toHaveBeenCalledWith(poolId, 'asset2');
      expect(checkUsersForLiquidationsAndBadDebt).toHaveBeenCalledWith(
        mockedDb,
        mockedSorobanHelper,
        poolId,
        [usersWithCollateral[0].user_id]
      );
    }
    expect(mockedSubmissionQueue.addSubmission).toHaveBeenCalledWith(liquidations[0], 3);
    expect(mockedSubmissionQueue.addSubmission).toHaveBeenCalledWith(liquidations[1], 3);
  });

  it('should handle LIQ_SCAN event', async () => {
    const appEvent: AppEvent = {
      type: EventType.LIQ_SCAN,
    } as LiqScanEvent;
    const liquidations: WorkSubmission[] = [
      {
        poolId: APP_CONFIG.pools[0],
        user: 'user1',
        type: WorkSubmissionType.AuctionCreation,
        auctionType: AuctionType.Liquidation,
        bid: ['asset1'],
        lot: ['asset2'],
        auctionPercent: 10,
      },
      {
        poolId: APP_CONFIG.pools[1],
        user: 'user2',
        type: WorkSubmissionType.AuctionCreation,
        auctionType: AuctionType.Liquidation,
        bid: ['asset1'],
        lot: ['asset1', 'asset2'],
        auctionPercent: 100,
      },
    ];
    mockedScanUsers.mockResolvedValue(liquidations);

    await workHandler.processEvent(appEvent);

    expect(mockedSubmissionQueue.addSubmission).toHaveBeenCalledWith(liquidations[0], 3);
    expect(mockedSubmissionQueue.addSubmission).toHaveBeenCalledWith(liquidations[1], 3);
  });

  it('should handle USER_REFRESH event', async () => {
    const cutoff = 5551234;
    const appEvent: AppEvent = {
      type: EventType.USER_REFRESH,
      cutoff: 5551234,
    } as UserRefreshEvent;

    const pool1Users: UserEntry[] = [
      {
        pool_id: 'pool1',
        user_id: 'user1',
        health_factor: 3.0,
        collateral: new Map([['asset2', BigInt(100)]]),
        liabilities: new Map([['asset1', BigInt(50)]]),
        updated: cutoff - 15 * 17280,
      },
      {
        pool_id: 'pool1',
        user_id: 'user2',
        health_factor: 2.5,
        collateral: new Map([['asset1', BigInt(100)]]),
        liabilities: new Map([['asset2', BigInt(50)]]),
        updated: cutoff - 13 * 17280,
      },
    ];
    const pool2Users: UserEntry[] = [
      {
        pool_id: 'pool2',
        user_id: 'user1',
        health_factor: 1.5,
        collateral: new Map([['asset2', BigInt(100)]]),
        liabilities: new Map([['asset1', BigInt(50)]]),
        updated: 0,
      },
    ];

    mockedSorobanHelper.loadPool.mockResolvedValue(mockPool);
    mockedDb.getUserEntriesUpdatedBefore
      .mockReturnValueOnce(pool1Users)
      .mockReturnValueOnce(pool2Users);

    await workHandler.processEvent(appEvent);

    expect(updateUser).toHaveBeenCalledTimes(3);
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it('should handle USER_REFRESH event even if one pool fails to load', async () => {
    const cutoff = 5551234;
    const appEvent: AppEvent = {
      type: EventType.USER_REFRESH,
      cutoff: 5551234,
    } as UserRefreshEvent;

    const pool1Users: UserEntry[] = [
      {
        pool_id: 'pool1',
        user_id: 'user1',
        health_factor: 3.0,
        collateral: new Map([['asset2', BigInt(100)]]),
        liabilities: new Map([['asset1', BigInt(50)]]),
        updated: cutoff - 15 * 17280,
      },
      {
        pool_id: 'pool1',
        user_id: 'user2',
        health_factor: 2.5,
        collateral: new Map([['asset1', BigInt(100)]]),
        liabilities: new Map([['asset2', BigInt(50)]]),
        updated: cutoff - 13 * 17280,
      },
    ];
    const pool2Users: UserEntry[] = [
      {
        pool_id: 'pool2',
        user_id: 'user1',
        health_factor: 1.5,
        collateral: new Map([['asset2', BigInt(100)]]),
        liabilities: new Map([['asset1', BigInt(50)]]),
        updated: 0,
      },
    ];

    mockedSorobanHelper.loadPool
      .mockRejectedValueOnce(new Error('Failed to load pool'))
      .mockResolvedValueOnce(mockPool);
    mockedDb.getUserEntriesUpdatedBefore.mockImplementation(
      (poolId: string, ledger: number, limit?: number | undefined) => {
        if (poolId === 'pool1') {
          return pool1Users;
        } else {
          return pool2Users;
        }
      }
    );

    await workHandler.processEvent(appEvent);

    expect(updateUser).toHaveBeenCalledTimes(1);
    expect(sendNotification).toHaveBeenCalledTimes(0);
  });
});
