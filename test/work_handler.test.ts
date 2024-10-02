import { PoolOracle } from '@blend-capital/blend-sdk';
import { AppEvent, EventType, OracleScanEvent } from '../src/events';
import { checkUsersForLiquidationsAndBadDebt } from '../src/liquidations';
import { OracleHistory } from '../src/oracle_history';
import { AuctioneerDatabase, UserEntry } from '../src/utils/db';
import { SorobanHelper } from '../src/utils/soroban_helper';
import { WorkHandler } from '../src/work_handler';
import { WorkSubmission, WorkSubmissionType, WorkSubmitter } from '../src/work_submitter';

jest.mock('../src/utils/prices');
jest.mock('../src/liquidations');
jest.mock('../src/user');
jest.mock('../src/utils/messages');
jest.mock('../src/utils/logger');
jest.mock('../src/utils/soroban_helper');

describe('WorkHandler', () => {
  let db: jest.Mocked<AuctioneerDatabase>;
  let submissionQueue: jest.Mocked<WorkSubmitter>;
  let oracleHistory: jest.Mocked<OracleHistory>;
  let sorobanHelper: jest.Mocked<SorobanHelper>;
  let workHandler: WorkHandler;

  beforeEach(() => {
    jest.clearAllMocks();
    db = {
      getUserEntriesWithLiability: jest.fn(),
      getUserEntriesWithCollateral: jest.fn(),
      getUserEntriesUpdatedBefore: jest.fn(),
    } as unknown as jest.Mocked<AuctioneerDatabase>;

    submissionQueue = {
      addSubmission: jest.fn(),
    } as unknown as jest.Mocked<WorkSubmitter>;

    oracleHistory = {
      getSignificantPriceChanges: jest.fn(),
    } as unknown as jest.Mocked<OracleHistory>;

    sorobanHelper = {
      loadPoolOracle: jest.fn(),
      loadPool: jest.fn(),
      loadUserPositionEstimate: jest.fn(),
    } as unknown as jest.Mocked<SorobanHelper>;
    workHandler = new WorkHandler(db, submissionQueue, oracleHistory, sorobanHelper);
  });

  it('should handle ORACLE_SCAN event', async () => {
    const appEvent: AppEvent = { type: EventType.ORACLE_SCAN } as OracleScanEvent;
    const poolOracle = new PoolOracle('', new Map(), 7, 0);
    const priceChanges = { up: ['asset1'], down: ['asset2'] };
    const usersWithLiability: UserEntry[] = [
      {
        user_id: 'user1',
        health_factor: 0,
        collateral: new Map([['asset2', BigInt(100)]]),
        liabilities: new Map([['asset1', BigInt(50)]]),
        updated: 0,
      },
    ];
    const usersWithCollateral: UserEntry[] = [
      {
        user_id: 'user1',
        health_factor: 0,
        collateral: new Map([['asset2', BigInt(100)]]),
        liabilities: new Map([['asset1', BigInt(50)]]),
        updated: 0,
      },
    ];
    const liquidations: WorkSubmission[] = [
      { user: 'user1', type: WorkSubmissionType.LiquidateUser, liquidationPercent: 10n },
    ];
    sorobanHelper.loadPoolOracle.mockResolvedValue(poolOracle);
    oracleHistory.getSignificantPriceChanges.mockReturnValue(priceChanges);
    db.getUserEntriesWithLiability.mockReturnValue(usersWithLiability);
    db.getUserEntriesWithCollateral.mockReturnValue(usersWithCollateral);
    (checkUsersForLiquidationsAndBadDebt as jest.Mock).mockResolvedValue(liquidations);

    await workHandler.processEvent(appEvent);

    expect(sorobanHelper.loadPoolOracle).toHaveBeenCalled();
    expect(oracleHistory.getSignificantPriceChanges).toHaveBeenCalledWith(poolOracle);
    expect(db.getUserEntriesWithLiability).toHaveBeenCalledWith('asset1');
    expect(db.getUserEntriesWithCollateral).toHaveBeenCalledWith('asset2');
    expect(checkUsersForLiquidationsAndBadDebt).toHaveBeenCalledWith(db, sorobanHelper, [
      usersWithCollateral[0].user_id,
    ]);
    expect(submissionQueue.addSubmission).toHaveBeenCalledWith(liquidations[0], 3);
  });
});
