import { PoolUser, Positions, PositionsEstimate } from '@blend-capital/blend-sdk';
import {
  isLiquidatable,
  isBadDebt,
  calculateLiquidationPercent,
  scanUsers,
  checkUsersForLiquidationsAndBadDebt,
} from '../src/liquidations';
import { AuctioneerDatabase } from '../src/utils/db.js';
import { PoolUserEst, SorobanHelper } from '../src/utils/soroban_helper.js';
import {
  inMemoryAuctioneerDb,
  mockedPool,
  mockPoolUser,
  mockPoolUserEstimate,
} from './helpers/mocks.js';
import { UserLiquidation, WorkSubmission, WorkSubmissionType } from '../src/work_submitter.js';
import { APP_CONFIG } from '../src/utils/config.js';

jest.mock('../src/utils/soroban_helper.js');
jest.mock('../src/utils/logger.js', () => ({
  logger: {
    error: jest.fn(),
    info: jest.fn(),
  },
}));
jest.mock('../src/utils/config.js', () => {
  return {
    APP_CONFIG: {
      backstopAddress: 'backstopAddress',
    },
  };
});
jest.mock('../src/user.js', () => {
  return {
    updateUser: jest.fn(),
  };
});

describe('isLiquidatable', () => {
  let userEstimate: PositionsEstimate;

  beforeEach(() => {
    userEstimate = mockPoolUserEstimate;
    userEstimate.totalEffectiveCollateral = 25000;
    userEstimate.totalEffectiveLiabilities = 1000;
  });

  it('returns true if the userEstimate health factor is below .99', async () => {
    userEstimate.totalEffectiveCollateral = 1000;
    userEstimate.totalEffectiveLiabilities = 1011;
    const result = isLiquidatable(userEstimate);
    expect(result).toBe(true);
  });

  it('returns false if the userEstimate health facotr is above .99', async () => {
    userEstimate.totalEffectiveCollateral = 1000;
    userEstimate.totalEffectiveLiabilities = 1010;
    const result = isLiquidatable(userEstimate);
    expect(result).toBe(false);
  });
});

describe('isBadDebt', () => {
  let userEstimate: PositionsEstimate;

  beforeEach(() => {
    userEstimate = mockPoolUserEstimate;
    userEstimate.totalEffectiveCollateral = 25000;
    userEstimate.totalEffectiveLiabilities = 1000;
  });
  it('should return true when totalEffectiveCollateral is 0 and totalEffectiveLiabilities is greater than 0', () => {
    userEstimate.totalEffectiveCollateral = 0;
    userEstimate.totalEffectiveLiabilities = 100;
    expect(isBadDebt(userEstimate)).toBe(true);
  });

  it('should return false when totalEffectiveCollateral is greater than 0 and totalEffectiveLiabilities is greater than 0', () => {
    userEstimate.totalEffectiveCollateral = 100;
    userEstimate.totalEffectiveLiabilities = 100;
    expect(isBadDebt(userEstimate)).toBe(false);
  });

  it('should return false when totalEffectiveCollateral is 0 and totalEffectiveLiabilities is 0', () => {
    userEstimate.totalEffectiveCollateral = 0;
    userEstimate.totalEffectiveLiabilities = 0;
    expect(isBadDebt(userEstimate)).toBe(false);
  });

  it('should return false when totalEffectiveCollateral is greater than 0 and totalEffectiveLiabilities is 0', () => {
    userEstimate.totalEffectiveCollateral = 100;
    userEstimate.totalEffectiveLiabilities = 0;
    expect(isBadDebt(userEstimate)).toBe(false);
  });
});

describe('calculateLiquidationPercent', () => {
  let userEstimate: PositionsEstimate;

  beforeEach(() => {
    userEstimate = mockPoolUserEstimate;
    userEstimate.totalEffectiveCollateral = 0;
    userEstimate.totalEffectiveLiabilities = 0;
    userEstimate.totalBorrowed = 0;
    userEstimate.totalSupplied = 0;
  });
  it('should calculate the correct liquidation percent for typical values', () => {
    userEstimate.totalEffectiveCollateral = 1000;
    userEstimate.totalEffectiveLiabilities = 1100;
    userEstimate.totalBorrowed = 1500;
    userEstimate.totalSupplied = 2000;
    const result = calculateLiquidationPercent(userEstimate);
    expect(Number(result)).toBe(62);
  });

  it('should calculate max of 100 percent liquidation size', () => {
    userEstimate.totalEffectiveCollateral = 1700;
    userEstimate.totalEffectiveLiabilities = 2200;
    userEstimate.totalBorrowed = 1900;
    userEstimate.totalSupplied = 2000;
    const result = calculateLiquidationPercent(userEstimate);

    expect(Number(result)).toBe(100);
  });

  it('should calculate the smallest possible liquidation size', () => {
    userEstimate.totalEffectiveCollateral = 2199;
    userEstimate.totalEffectiveLiabilities = 2200;
    userEstimate.totalBorrowed = 1900;
    userEstimate.totalSupplied = 10000000000000;
    const result = calculateLiquidationPercent(userEstimate);

    expect(Number(result)).toBe(9);
  });
});

describe('scanUsers', () => {
  let db: AuctioneerDatabase;
  let mockedSorobanHelper: jest.Mocked<SorobanHelper>;
  let mockBackstopPositions: PoolUser;
  let mockBackstopPositionsEstimate: PositionsEstimate;
  beforeEach(() => {
    db = inMemoryAuctioneerDb();
    mockedSorobanHelper = new SorobanHelper() as jest.Mocked<SorobanHelper>;
    mockedSorobanHelper.loadPool.mockResolvedValue(mockedPool);
    mockBackstopPositions = new PoolUser(
      'backstopAddress',
      new Positions(new Map(), new Map(), new Map()),
      new Map()
    );
    mockBackstopPositionsEstimate = new PositionsEstimate(0, 0, 0, 0, 0, 0, 0, 0, 0);
  });

  it('should create a work submission for liquidatable users', async () => {
    mockPoolUserEstimate.totalEffectiveCollateral = 1000;
    mockPoolUserEstimate.totalEffectiveLiabilities = 1100;
    mockPoolUserEstimate.totalBorrowed = 1500;
    mockPoolUserEstimate.totalSupplied = 2000;
    db.setUserEntry({
      user_id: mockPoolUser.userId,
      health_factor:
        mockPoolUserEstimate.totalEffectiveCollateral /
        mockPoolUserEstimate.totalEffectiveLiabilities,
      collateral: new Map(),
      liabilities: new Map(),
      updated: 123,
    });
    mockedSorobanHelper.loadUserPositionEstimate.mockImplementation((address: string) => {
      if (address === mockPoolUser.userId) {
        return Promise.resolve({
          estimate: mockPoolUserEstimate,
          user: mockPoolUser,
        } as PoolUserEst);
      } else if (address === 'backstopAddress') {
        return Promise.resolve({
          estimate: mockBackstopPositionsEstimate,
          user: mockBackstopPositions,
        } as PoolUserEst);
      }
      return Promise.resolve({ estimate: {}, user: {} } as PoolUserEst);
    });
    mockedSorobanHelper.loadAuction.mockResolvedValue(undefined);

    let liquidations = await scanUsers(db, mockedSorobanHelper);
    expect(liquidations.length).toBe(1);
  });

  it('should not create a work submission for users with existing liquidation auctions', async () => {
    mockPoolUserEstimate.totalEffectiveCollateral = 1000;
    mockPoolUserEstimate.totalEffectiveLiabilities = 1100;
    mockPoolUserEstimate.totalBorrowed = 1500;
    mockPoolUserEstimate.totalSupplied = 2000;
    db.setUserEntry({
      user_id: mockPoolUser.userId,
      health_factor:
        mockPoolUserEstimate.totalEffectiveCollateral /
        mockPoolUserEstimate.totalEffectiveLiabilities,
      collateral: new Map(),
      liabilities: new Map(),
      updated: 123,
    });
    mockedSorobanHelper.loadUserPositionEstimate.mockImplementation((address: string) => {
      if (address === mockPoolUser.userId) {
        return Promise.resolve({
          estimate: mockPoolUserEstimate,
          user: mockPoolUser,
        } as PoolUserEst);
      } else if (address === 'backstopAddress') {
        return Promise.resolve({
          estimate: mockBackstopPositionsEstimate,
          user: mockBackstopPositions,
        } as PoolUserEst);
      }
      return Promise.resolve({ estimate: {}, user: {} } as PoolUserEst);
    });
    mockedSorobanHelper.loadAuction.mockResolvedValue({
      bid: new Map(),
      lot: new Map(),
      block: 123,
    });

    let liquidations = await scanUsers(db, mockedSorobanHelper);
    expect(liquidations.length).toBe(0);
  });

  it('Checks backstop for bad debt when no users exist', async () => {
    mockBackstopPositionsEstimate.totalEffectiveLiabilities = 1000;
    mockBackstopPositionsEstimate.totalEffectiveCollateral = 0;
    mockedSorobanHelper.loadUserPositionEstimate.mockImplementation((address: string) => {
      if (address === mockPoolUser.userId) {
        return Promise.resolve({
          estimate: mockPoolUserEstimate,
          user: mockPoolUser,
        } as PoolUserEst);
      } else if (address === 'backstopAddress') {
        return Promise.resolve({
          estimate: mockBackstopPositionsEstimate,
          user: mockBackstopPositions,
        } as PoolUserEst);
      }
      return Promise.resolve({ estimate: {}, user: {} } as PoolUserEst);
    });

    let liquidations = await scanUsers(db, mockedSorobanHelper);
    expect(liquidations.length).toBe(1);
  });
});

describe('checkUsersForLiquidationsAndBadDebt', () => {
  let db: AuctioneerDatabase;
  let mockedSorobanHelper: jest.Mocked<SorobanHelper>;
  let mockBackstopPositions: PoolUser;
  let mockBackstopPositionsEstimate: PositionsEstimate;
  let mockUser: PoolUser;
  let mockUserEstimate: PositionsEstimate;

  beforeEach(() => {
    db = inMemoryAuctioneerDb();
    mockedSorobanHelper = new SorobanHelper() as jest.Mocked<SorobanHelper>;
    mockedSorobanHelper.loadPool.mockResolvedValue(mockedPool);
    mockBackstopPositions = new PoolUser(
      'backstopAddress',
      new Positions(new Map(), new Map(), new Map()),
      new Map()
    );
    mockBackstopPositionsEstimate = new PositionsEstimate(0, 0, 0, 0, 0, 0, 0, 0, 0);
    mockUser = mockPoolUser;
    mockUserEstimate = mockPoolUserEstimate;
  });

  it('should return an empty array when user_ids is empty', async () => {
    const result = await checkUsersForLiquidationsAndBadDebt(db, mockedSorobanHelper, []);
    expect(result).toEqual([]);
  });

  it('should handle backstop address user correctly', async () => {
    const user_ids = [APP_CONFIG.backstopAddress];
    (mockedSorobanHelper.loadPool as jest.Mock).mockResolvedValue(mockedPool);
    mockBackstopPositionsEstimate.totalEffectiveLiabilities = 1000;
    mockBackstopPositionsEstimate.totalEffectiveCollateral = 0;
    (mockedSorobanHelper.loadUserPositionEstimate as jest.Mock).mockResolvedValue({
      estimate: mockBackstopPositionsEstimate,
      user: mockBackstopPositions,
    });
    (mockedSorobanHelper.loadAuction as jest.Mock).mockResolvedValue(undefined);

    const result = await checkUsersForLiquidationsAndBadDebt(db, mockedSorobanHelper, user_ids);

    expect(result).toEqual([{ type: WorkSubmissionType.BadDebtAuction }]);
  });

  it('should handle users with liquidations correctly', async () => {
    const user_ids = ['user1'];
    (mockedSorobanHelper.loadPool as jest.Mock).mockResolvedValue(mockedPool);
    mockUserEstimate.totalEffectiveCollateral = 1000;
    mockUserEstimate.totalEffectiveLiabilities = 1100;
    (mockedSorobanHelper.loadUserPositionEstimate as jest.Mock).mockResolvedValue({
      estimate: mockUserEstimate,
      user: mockUser,
    });
    (mockedSorobanHelper.loadAuction as jest.Mock).mockResolvedValue(undefined);

    const result = await checkUsersForLiquidationsAndBadDebt(db, mockedSorobanHelper, user_ids);

    expect(result.length).toBe(1);
    expect(result[0].type).toBe(WorkSubmissionType.LiquidateUser);

    // Type Guard Function
    function isUserLiquidation(workSubmission: WorkSubmission): workSubmission is UserLiquidation {
      return 'user' in workSubmission && 'liquidationPercent' in workSubmission;
    }
    // Test Case
    const workSubmission = result[0] as WorkSubmission;

    if (isUserLiquidation(workSubmission)) {
      expect(workSubmission.user).toBe('user1');
      expect(Number(workSubmission.liquidationPercent)).toBe(62);
    } else {
      throw new Error('Expected workSubmission to be of type LiquidateUser');
    }
  });

  it('should handle users with bad debt correctly', async () => {
    const user_ids = ['user1'];
    (mockedSorobanHelper.loadPool as jest.Mock).mockResolvedValue(mockedPool);
    mockUserEstimate.totalEffectiveCollateral = 0;
    mockUserEstimate.totalEffectiveLiabilities = 1100;
    (mockedSorobanHelper.loadUserPositionEstimate as jest.Mock).mockResolvedValue({
      estimate: mockUserEstimate,
      user: mockUser,
    });
    (mockedSorobanHelper.loadAuction as jest.Mock).mockResolvedValue(undefined);

    const result = await checkUsersForLiquidationsAndBadDebt(db, mockedSorobanHelper, user_ids);

    expect(result.length).toBe(1);
    expect(result[0].type).toBe(WorkSubmissionType.BadDebtTransfer);

    // Type Guard Function
    expect(result).toEqual([{ type: WorkSubmissionType.BadDebtTransfer, user: 'user1' }]);
  });
});
