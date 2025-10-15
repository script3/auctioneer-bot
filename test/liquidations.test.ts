import {
  Auction,
  AuctionType,
  PoolUser,
  Positions,
  PositionsEstimate,
} from '@blend-capital/blend-sdk';
import { Keypair } from '@stellar/stellar-sdk';
import {
  calculateLiquidation,
  checkUsersForLiquidationsAndBadDebt,
  isBadDebt,
  isLiquidatable,
  scanUsers,
} from '../src/liquidations';
import { APP_CONFIG } from '../src/utils/config.js';
import { AuctioneerDatabase } from '../src/utils/db.js';
import { PoolUserEst, SorobanHelper } from '../src/utils/soroban_helper.js';
import { WorkSubmissionType } from '../src/work_submitter.js';
import {
  AQUA,
  AQUA_ID,
  EURC,
  EURC_ID,
  inMemoryAuctioneerDb,
  mockPool,
  mockPoolOracle,
  USDC,
  USDC_ID,
  XLM,
  XLM_ID,
} from './helpers/mocks.js';
import { buildAuction } from './helpers/utils.js';
import { sendNotification } from '../src/utils/notifier.js';
import { logger } from '../src/utils/logger.js';

jest.mock('../src/utils/soroban_helper.js');
jest.mock('../src/utils/notifier.js');
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
      backstopTokenAddress: 'backstopTokenAddress',
      pools: ['pool1', 'pool2'],
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
    userEstimate = new PositionsEstimate(0, 0, 0, 0, 0, 0, 0, 0, 0);
  });

  it('returns true if the userEstimate health factor is lt .998', async () => {
    userEstimate.totalEffectiveCollateral = 1000;
    userEstimate.totalEffectiveLiabilities = 1003;
    const result = isLiquidatable(userEstimate);
    expect(result).toBe(true);
  });

  it('returns false if the userEstimate health facotr is gte to .998', async () => {
    userEstimate.totalEffectiveCollateral = 1000;
    userEstimate.totalEffectiveLiabilities = 1002;
    const result = isLiquidatable(userEstimate);
    expect(result).toBe(false);
  });
});

describe('isBadDebt', () => {
  let userEstimate: PositionsEstimate;

  beforeEach(() => {
    userEstimate = new PositionsEstimate(0, 0, 0, 0, 0, 0, 0, 0, 0);
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

describe('calculateLiquidation', () => {
  let userEstimate: PositionsEstimate;
  let userPositions: Positions;

  beforeEach(() => {
    userEstimate = new PositionsEstimate(0, 0, 0, 0, 0, 0, 0, 0, 0);
  });
  it('should find auction subset with partial auction', () => {
    let userPositions = new Positions(
      new Map([
        [USDC_ID, BigInt(2000e7)],
        [EURC_ID, BigInt(1000e7)],
      ]),
      new Map([
        [XLM_ID, BigInt(38000e7)],
        [EURC_ID, BigInt(500e7)],
      ]),
      new Map([])
    );
    userEstimate = PositionsEstimate.build(mockPool, mockPoolOracle, userPositions);

    const result = calculateLiquidation(mockPool, userPositions, userEstimate, mockPoolOracle);

    let [auction, auctionEstimate] = buildAuction(
      userPositions,
      result.auctionPercent,
      result.bid,
      result.lot,
      mockPool,
      mockPoolOracle
    );
    let postAuctionUser = userPositions;

    for (let [index, amount] of auction.collateral) {
      postAuctionUser.collateral.set(index, postAuctionUser.collateral.get(index)! - amount);
    }

    for (let [index, amount] of auction.liabilities) {
      postAuctionUser.liabilities.set(index, postAuctionUser.liabilities.get(index)! - amount);
    }

    const userEstimateAfterAuction = PositionsEstimate.build(
      mockPool,
      mockPoolOracle,
      postAuctionUser
    );

    expect(result.auctionPercent).toBe(46);
    expect(result.bid).toContain(USDC);
    expect(result.lot).toContain(XLM);
    expect(auctionEstimate.totalSupplied > auctionEstimate.totalBorrowed).toBe(true);
    expect(userEstimateAfterAuction.totalEffectiveCollateral).toBeGreaterThan(
      userEstimateAfterAuction.totalEffectiveLiabilities
    );

    // Check the assets are sorted by value (highest first)
    const collateralValues = result.lot.map((assetId) => {
      const index = mockPool.metadata.reserveList.indexOf(assetId);
      const amount = userPositions.collateral.get(index) || BigInt(0);
      const price = mockPoolOracle.getPriceFloat(assetId) || 0;
      const reserve = mockPool.reserves.get(assetId);
      if (!reserve) return 0;
      return reserve.toEffectiveAssetFromBTokenFloat(amount) * price;
    });

    // Check that values are in descending order
    for (let i = 1; i < collateralValues.length; i++) {
      expect(collateralValues[i - 1]).toBeGreaterThanOrEqual(collateralValues[i]);
    }

    const liabilityValues = result.bid.map((assetId) => {
      const index = mockPool.metadata.reserveList.indexOf(assetId);
      const amount = userPositions.liabilities.get(index) || BigInt(0);
      const price = mockPoolOracle.getPriceFloat(assetId) || 0;
      const reserve = mockPool.reserves.get(assetId);
      if (!reserve) return 0;
      return reserve.toEffectiveAssetFromDTokenFloat(amount) * price;
    });

    // Check that liability values are in descending order
    for (let i = 1; i < liabilityValues.length; i++) {
      expect(liabilityValues[i - 1]).toBeGreaterThanOrEqual(liabilityValues[i]);
    }
  });

  it('should return 100% liquidation when health factor is very poor', () => {
    // Create positions with very high liabilities compared to collateral
    userPositions = new Positions(
      new Map([
        [USDC_ID, BigInt(5000e7)],
        [XLM_ID, BigInt(1e7)],
        [AQUA_ID, BigInt(1e7)],
      ]),
      new Map([[XLM_ID, BigInt(500e7)]]),
      new Map([])
    );

    userEstimate = PositionsEstimate.build(mockPool, mockPoolOracle, userPositions);

    const result = calculateLiquidation(mockPool, userPositions, userEstimate, mockPoolOracle);
    expect(result.auctionPercent).toBe(100);
    expect(result.bid).toContain(USDC);
    expect(result.bid).toContain(XLM);
    expect(result.bid).toContain(AQUA);
    expect(result.lot).toContain(XLM);
  });

  it('should calculate partial liquidation for marginally unhealthy position with no valid subsets', () => {
    userPositions = new Positions(
      new Map([
        [USDC_ID, BigInt(1200e7)],
        [AQUA_ID, BigInt(800000e7)],
      ]),
      new Map([
        [XLM_ID, BigInt(13050e7)],
        [EURC_ID, BigInt(1150e7)],
      ]),
      new Map([])
    );

    // Setup for a position just slightly below health threshold
    userEstimate = PositionsEstimate.build(mockPool, mockPoolOracle, userPositions);
    const result = calculateLiquidation(mockPool, userPositions, userEstimate, mockPoolOracle);
    let [auction, auctionEstimate] = buildAuction(
      userPositions,
      result.auctionPercent,
      result.bid,
      result.lot,
      mockPool,
      mockPoolOracle
    );

    let postAuctionUser = userPositions;

    for (let [index, amount] of auction.collateral) {
      postAuctionUser.collateral.set(index, postAuctionUser.collateral.get(index)! - amount);
    }

    for (let [index, amount] of auction.liabilities) {
      postAuctionUser.liabilities.set(index, postAuctionUser.liabilities.get(index)! - amount);
    }

    const userEstimateAfterAuction = PositionsEstimate.build(
      mockPool,
      mockPoolOracle,
      postAuctionUser
    );

    expect(result.auctionPercent).toBe(45);
    expect(result.bid).toContain(USDC);
    expect(result.bid).toContain(AQUA);
    expect(result.lot).toContain(XLM);
    expect(result.lot).toContain(EURC);
    expect(auctionEstimate.totalSupplied > auctionEstimate.totalBorrowed).toBe(true);
    expect(userEstimateAfterAuction.totalEffectiveCollateral).toBeGreaterThan(
      userEstimateAfterAuction.totalEffectiveLiabilities
    );

    // Check the assets are sorted by value (highest first)
    const collateralValues = result.lot.map((assetId) => {
      const index = mockPool.metadata.reserveList.indexOf(assetId);
      const amount = userPositions.collateral.get(index) || BigInt(0);
      const price = mockPoolOracle.getPriceFloat(assetId) || 0;
      const reserve = mockPool.reserves.get(assetId);
      if (!reserve) return 0;
      return reserve.toEffectiveAssetFromBTokenFloat(amount) * price;
    });

    // Check that values are in descending order
    for (let i = 1; i < collateralValues.length; i++) {
      expect(collateralValues[i - 1]).toBeGreaterThanOrEqual(collateralValues[i]);
    }

    const liabilityValues = result.bid.map((assetId) => {
      const index = mockPool.metadata.reserveList.indexOf(assetId);
      const amount = userPositions.liabilities.get(index) || BigInt(0);
      const price = mockPoolOracle.getPriceFloat(assetId) || 0;
      const reserve = mockPool.reserves.get(assetId);
      if (!reserve) return 0;
      return reserve.toEffectiveAssetFromDTokenFloat(amount) * price;
    });

    // Check that liability values are in descending order
    for (let i = 1; i < liabilityValues.length; i++) {
      expect(liabilityValues[i - 1]).toBeGreaterThanOrEqual(liabilityValues[i]);
    }
  });

  it('should find auction with single collateral and multiple liabilities', () => {
    userPositions = new Positions(
      new Map([
        [USDC_ID, BigInt(1100e7)],
        [AQUA_ID, BigInt(850000e7)],
        [XLM_ID, BigInt(9000e7)],
      ]),
      new Map([[EURC_ID, BigInt(3000e7)]]),
      new Map([])
    );

    // Setup for a position just slightly below health threshold
    userEstimate = PositionsEstimate.build(mockPool, mockPoolOracle, userPositions);
    const result = calculateLiquidation(mockPool, userPositions, userEstimate, mockPoolOracle);
    let [auction, auctionEstimate] = buildAuction(
      userPositions,
      result.auctionPercent,
      result.bid,
      result.lot,
      mockPool,
      mockPoolOracle
    );

    let postAuctionUser = userPositions;

    for (let [index, amount] of auction.collateral) {
      postAuctionUser.collateral.set(index, postAuctionUser.collateral.get(index)! - amount);
    }

    for (let [index, amount] of auction.liabilities) {
      postAuctionUser.liabilities.set(index, postAuctionUser.liabilities.get(index)! - amount);
    }

    const userEstimateAfterAuction = PositionsEstimate.build(
      mockPool,
      mockPoolOracle,
      postAuctionUser
    );

    expect(result.auctionPercent).toBe(71);
    expect(result.bid).toContain(USDC);
    expect(result.bid).toContain(AQUA);
    expect(result.bid).toContain(XLM);
    expect(result.lot).toContain(EURC);
    expect(auctionEstimate.totalSupplied > auctionEstimate.totalBorrowed).toBe(true);
    expect(userEstimateAfterAuction.totalEffectiveCollateral).toBeGreaterThan(
      userEstimateAfterAuction.totalEffectiveLiabilities
    );
  });

  it('should find auction with single liability and multiple collaterals', () => {
    userPositions = new Positions(
      new Map([[XLM_ID, BigInt(21000e7)]]),
      new Map([
        [USDC_ID, BigInt(1000e7)],
        [XLM_ID, BigInt(8000e7)],
        [EURC_ID, BigInt(1000e7)],
      ]),
      new Map([])
    );

    // Setup for a position just slightly below health threshold
    userEstimate = PositionsEstimate.build(mockPool, mockPoolOracle, userPositions);
    const result = calculateLiquidation(mockPool, userPositions, userEstimate, mockPoolOracle);
    let [auction, auctionEstimate] = buildAuction(
      userPositions,
      result.auctionPercent,
      result.bid,
      result.lot,
      mockPool,
      mockPoolOracle
    );

    let postAuctionUser = userPositions;

    for (let [index, amount] of auction.collateral) {
      postAuctionUser.collateral.set(index, postAuctionUser.collateral.get(index)! - amount);
    }

    for (let [index, amount] of auction.liabilities) {
      postAuctionUser.liabilities.set(index, postAuctionUser.liabilities.get(index)! - amount);
    }

    const userEstimateAfterAuction = PositionsEstimate.build(
      mockPool,
      mockPoolOracle,
      postAuctionUser
    );

    expect(result.auctionPercent).toBe(56);
    expect(result.lot).toContain(USDC);
    expect(result.lot).toContain(EURC);
    expect(result.bid).toContain(XLM);
    expect(auctionEstimate.totalSupplied > auctionEstimate.totalBorrowed).toBe(true);
    expect(userEstimateAfterAuction.totalEffectiveCollateral).toBeGreaterThan(
      userEstimateAfterAuction.totalEffectiveLiabilities
    );
  });

  it('should find partial auction with single liability and single collateral', () => {
    userPositions = new Positions(
      new Map([[XLM_ID, BigInt(74e7)]]),
      new Map([[USDC_ID, BigInt(10e7)]]),
      new Map([])
    );

    // Setup for a position just slightly below health threshold
    userEstimate = PositionsEstimate.build(mockPool, mockPoolOracle, userPositions);
    const result = calculateLiquidation(mockPool, userPositions, userEstimate, mockPoolOracle);
    let [auction, auctionEstimate] = buildAuction(
      userPositions,
      result.auctionPercent,
      result.bid,
      result.lot,
      mockPool,
      mockPoolOracle
    );

    let postAuctionUser = userPositions;

    for (let [index, amount] of auction.collateral) {
      postAuctionUser.collateral.set(index, postAuctionUser.collateral.get(index)! - amount);
    }

    for (let [index, amount] of auction.liabilities) {
      postAuctionUser.liabilities.set(index, postAuctionUser.liabilities.get(index)! - amount);
    }

    const userEstimateAfterAuction = PositionsEstimate.build(
      mockPool,
      mockPoolOracle,
      postAuctionUser
    );

    expect(result.auctionPercent).toBe(33);
    expect(result.lot).toContain(USDC);
    expect(result.bid).toContain(XLM);
    expect(auctionEstimate.totalSupplied > auctionEstimate.totalBorrowed).toBe(true);
    expect(userEstimateAfterAuction.totalEffectiveCollateral).toBeGreaterThan(
      userEstimateAfterAuction.totalEffectiveLiabilities
    );
  });

  it('should find full auction with single liability and single collateral', () => {
    userPositions = new Positions(
      new Map([[XLM_ID, BigInt(89e7)]]),
      new Map([[USDC_ID, BigInt(10e7)]]),
      new Map([])
    );

    // Setup for a position just slightly below health threshold
    userEstimate = PositionsEstimate.build(mockPool, mockPoolOracle, userPositions);
    const result = calculateLiquidation(mockPool, userPositions, userEstimate, mockPoolOracle);
    let [auction, auctionEstimate] = buildAuction(
      userPositions,
      result.auctionPercent,
      result.bid,
      result.lot,
      mockPool,
      mockPoolOracle
    );

    let postAuctionUser = userPositions;

    for (let [index, amount] of auction.collateral) {
      postAuctionUser.collateral.set(index, postAuctionUser.collateral.get(index)! - amount);
    }

    for (let [index, amount] of auction.liabilities) {
      postAuctionUser.liabilities.set(index, postAuctionUser.liabilities.get(index)! - amount);
    }

    const userEstimateAfterAuction = PositionsEstimate.build(
      mockPool,
      mockPoolOracle,
      postAuctionUser
    );

    expect(result.auctionPercent).toBe(100);
    expect(result.lot).toContain(USDC);
    expect(result.bid).toContain(XLM);
    expect(auctionEstimate.totalSupplied > auctionEstimate.totalBorrowed).toBe(true);
  });
});

describe('scanUsers', () => {
  let db: AuctioneerDatabase;
  let mockedSorobanHelper: jest.Mocked<SorobanHelper>;
  let mockBackstopPositions: PoolUser;
  let mockBackstopPositionsEstimate: PositionsEstimate;
  let mockPoolUserEstimate: PositionsEstimate;
  let mockPoolUser: PoolUser;

  beforeEach(() => {
    db = inMemoryAuctioneerDb();
    mockedSorobanHelper = new SorobanHelper() as jest.Mocked<SorobanHelper>;
    mockedSorobanHelper.loadPool.mockResolvedValue(mockPool);
    mockBackstopPositions = new PoolUser(
      'backstopAddress',
      new Positions(new Map(), new Map(), new Map()),
      new Map()
    );
    mockBackstopPositionsEstimate = new PositionsEstimate(0, 0, 0, 0, 0, 0, 0, 0, 0);
    mockPoolUserEstimate = new PositionsEstimate(0, 0, 0, 0, 0, 0, 0, 0, 0);
    mockPoolUser = new PoolUser(
      Keypair.random().publicKey(),
      new Positions(new Map(), new Map(), new Map()),
      new Map()
    );
  });

  it('should create a work submission for liquidatable users', async () => {
    mockPoolUser.positions = new Positions(
      new Map([[USDC_ID, BigInt(300e7)]]),
      new Map([[XLM_ID, BigInt(3000e7)]]),
      new Map()
    );
    mockPoolUserEstimate = PositionsEstimate.build(
      mockPool,
      mockPoolOracle,
      mockPoolUser.positions
    );
    db.setUserEntry({
      pool_id: 'pool1',
      user_id: mockPoolUser.userId,
      health_factor:
        mockPoolUserEstimate.totalEffectiveCollateral /
        mockPoolUserEstimate.totalEffectiveLiabilities,
      collateral: new Map(),
      liabilities: new Map(),
      updated: 123,
    });
    db.setUserEntry({
      pool_id: 'pool2',
      user_id: mockPoolUser.userId,
      health_factor:
        mockPoolUserEstimate.totalEffectiveCollateral /
        mockPoolUserEstimate.totalEffectiveLiabilities,
      collateral: new Map(),
      liabilities: new Map(),
      updated: 123,
    });
    mockedSorobanHelper.loadUserPositionEstimate.mockImplementation(
      (poolId: string, userId: string) => {
        if (userId === mockPoolUser.userId) {
          return Promise.resolve({
            estimate: mockPoolUserEstimate,
            user: mockPoolUser,
          } as PoolUserEst);
        } else if (userId === 'backstopAddress') {
          return Promise.resolve({
            estimate: mockBackstopPositionsEstimate,
            user: mockBackstopPositions,
          } as PoolUserEst);
        }
        return Promise.resolve({ estimate: {}, user: {} } as PoolUserEst);
      }
    );
    mockedSorobanHelper.loadPoolOracle.mockResolvedValue(mockPoolOracle);
    mockedSorobanHelper.loadAuction.mockResolvedValue(undefined);

    let liquidations = await scanUsers(db, mockedSorobanHelper);
    expect(liquidations.length).toBe(2);
  });

  it('should not create a work submission for users with existing liquidation auctions', async () => {
    mockPoolUserEstimate.totalEffectiveCollateral = 1000;
    mockPoolUserEstimate.totalEffectiveLiabilities = 1100;
    mockPoolUserEstimate.totalBorrowed = 1500;
    mockPoolUserEstimate.totalSupplied = 2000;
    db.setUserEntry({
      pool_id: 'pool1',
      user_id: mockPoolUser.userId,
      health_factor:
        mockPoolUserEstimate.totalEffectiveCollateral /
        mockPoolUserEstimate.totalEffectiveLiabilities,
      collateral: new Map(),
      liabilities: new Map(),
      updated: 123,
    });
    mockedSorobanHelper.loadUserPositionEstimate.mockImplementation(
      (poolId: string, userId: string) => {
        if (userId === mockPoolUser.userId) {
          return Promise.resolve({
            estimate: mockPoolUserEstimate,
            user: mockPoolUser,
          } as PoolUserEst);
        } else if (userId === 'backstopAddress') {
          return Promise.resolve({
            estimate: mockBackstopPositionsEstimate,
            user: mockBackstopPositions,
          } as PoolUserEst);
        }
        return Promise.resolve({ estimate: {}, user: {} } as PoolUserEst);
      }
    );
    mockedSorobanHelper.loadAuction.mockResolvedValue({ user: 'exists' } as Auction);

    let liquidations = await scanUsers(db, mockedSorobanHelper);
    expect(liquidations.length).toBe(0);
  });

  it('Checks backstop for bad debt when no users exist', async () => {
    mockBackstopPositionsEstimate.totalEffectiveLiabilities = 1000;
    mockBackstopPositionsEstimate.totalEffectiveCollateral = 0;
    mockedSorobanHelper.loadUserPositionEstimate.mockImplementation(
      (poolId: string, userId: string) => {
        if (userId === mockPoolUser.userId) {
          return Promise.resolve({
            estimate: mockPoolUserEstimate,
            user: mockPoolUser,
          } as PoolUserEst);
        } else if (userId === APP_CONFIG.backstopAddress) {
          return Promise.resolve({
            estimate: mockBackstopPositionsEstimate,
            user: mockBackstopPositions,
          } as PoolUserEst);
        }
        return Promise.resolve({ estimate: {}, user: {} } as PoolUserEst);
      }
    );

    let liquidations = await scanUsers(db, mockedSorobanHelper);
    expect(liquidations.length).toBe(2); // 1 bad debt auction for each pool
  });

  it('should handle failures to load pool data', async () => {
    mockPoolUser.positions = new Positions(
      new Map([[USDC_ID, BigInt(300e7)]]),
      new Map([[XLM_ID, BigInt(3000e7)]]),
      new Map()
    );
    mockPoolUserEstimate = PositionsEstimate.build(
      mockPool,
      mockPoolOracle,
      mockPoolUser.positions
    );
    db.setUserEntry({
      pool_id: 'pool1',
      user_id: mockPoolUser.userId,
      health_factor:
        mockPoolUserEstimate.totalEffectiveCollateral /
        mockPoolUserEstimate.totalEffectiveLiabilities,
      collateral: new Map(),
      liabilities: new Map(),
      updated: 123,
    });
    db.setUserEntry({
      pool_id: 'pool2',
      user_id: mockPoolUser.userId,
      health_factor:
        mockPoolUserEstimate.totalEffectiveCollateral /
        mockPoolUserEstimate.totalEffectiveLiabilities,
      collateral: new Map(),
      liabilities: new Map(),
      updated: 123,
    });
    mockedSorobanHelper.loadUserPositionEstimate.mockImplementation(
      (poolId: string, userId: string) => {
        if (userId === mockPoolUser.userId) {
          return Promise.resolve({
            estimate: mockPoolUserEstimate,
            user: mockPoolUser,
          } as PoolUserEst);
        } else if (userId === 'backstopAddress') {
          return Promise.resolve({
            estimate: mockBackstopPositionsEstimate,
            user: mockBackstopPositions,
          } as PoolUserEst);
        }
        return Promise.resolve({ estimate: {}, user: {} } as PoolUserEst);
      }
    );
    mockedSorobanHelper.loadPoolOracle
      .mockRejectedValueOnce(new Error('Failed to load pool oracle'))
      .mockResolvedValueOnce(mockPoolOracle);
    mockedSorobanHelper.loadAuction.mockResolvedValue(undefined);

    let liquidations = await scanUsers(db, mockedSorobanHelper);
    expect(liquidations.length).toBe(1);
    const expectedErrorMessage = `Failed to scan for liquidations or bad debt in pool pool1: Error: Failed to load pool oracle`;
    expect(logger.error).toHaveBeenCalledWith(expectedErrorMessage);
    expect(sendNotification).toHaveBeenCalledWith(expectedErrorMessage);
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
    mockedSorobanHelper.loadPool.mockResolvedValue(mockPool);
    mockBackstopPositions = new PoolUser(
      'backstopAddress',
      new Positions(new Map(), new Map(), new Map()),
      new Map()
    );
    mockBackstopPositionsEstimate = new PositionsEstimate(0, 0, 0, 0, 0, 0, 0, 0, 0);
    mockUserEstimate = new PositionsEstimate(0, 0, 0, 0, 0, 0, 0, 0, 0);
    mockUser = new PoolUser(
      Keypair.random().publicKey(),
      new Positions(new Map(), new Map(), new Map()),
      new Map()
    );
  });

  it('should return an empty array when user_ids is empty', async () => {
    const result = await checkUsersForLiquidationsAndBadDebt(
      db,
      mockedSorobanHelper,
      mockPool.id,
      []
    );
    expect(result).toEqual([]);
  });

  it('should handle backstop address user correctly', async () => {
    const user_ids = [APP_CONFIG.backstopAddress];
    mockedSorobanHelper.loadPool.mockResolvedValue(mockPool);
    mockBackstopPositionsEstimate.totalEffectiveLiabilities = 1000;
    mockBackstopPositionsEstimate.totalEffectiveCollateral = 0;
    mockBackstopPositions.positions = new Positions(
      new Map([[USDC_ID, 2000n]]),
      new Map(),
      new Map()
    );
    mockedSorobanHelper.loadUserPositionEstimate.mockResolvedValue({
      estimate: mockBackstopPositionsEstimate,
      user: mockBackstopPositions,
    });
    mockedSorobanHelper.loadAuction.mockResolvedValue(undefined);

    const result = await checkUsersForLiquidationsAndBadDebt(
      db,
      mockedSorobanHelper,
      mockPool.id,
      user_ids
    );

    expect(result).toEqual([
      {
        type: WorkSubmissionType.AuctionCreation,
        poolId: mockPool.id,
        user: APP_CONFIG.backstopAddress,
        auctionType: AuctionType.BadDebt,
        bid: [USDC],
        lot: [APP_CONFIG.backstopTokenAddress],
        auctionPercent: 100,
      },
    ]);
  });

  it('should respect pool max positions for bad debt auctions', async () => {
    const user_ids = [APP_CONFIG.backstopAddress];

    mockedSorobanHelper.loadPool.mockResolvedValue(mockPool);
    mockBackstopPositionsEstimate.totalEffectiveLiabilities = 1000;
    mockBackstopPositionsEstimate.totalEffectiveCollateral = 0;
    // max positions is 4, so at most 3 positions should be used (given 1 is reserved for the lot asset)
    mockBackstopPositions.positions = new Positions(
      new Map([
        [USDC_ID, 2000n],
        [XLM_ID, 3000n],
        [EURC_ID, 4000n],
        [AQUA_ID, 5000n],
      ]),
      new Map(),
      new Map()
    );
    mockedSorobanHelper.loadUserPositionEstimate.mockResolvedValue({
      estimate: mockBackstopPositionsEstimate,
      user: mockBackstopPositions,
    });
    mockedSorobanHelper.loadAuction.mockResolvedValue(undefined);

    const result = await checkUsersForLiquidationsAndBadDebt(
      db,
      mockedSorobanHelper,
      mockPool.id,
      user_ids
    );

    expect(result).toEqual([
      {
        type: WorkSubmissionType.AuctionCreation,
        poolId: mockPool.id,
        user: APP_CONFIG.backstopAddress,
        auctionType: AuctionType.BadDebt,
        bid: [USDC, XLM, EURC],
        lot: [APP_CONFIG.backstopTokenAddress],
        auctionPercent: 100,
      },
    ]);
  });

  it('should handle liquidatable users correctly', async () => {
    const user_ids = ['user1'];
    mockedSorobanHelper.loadPool.mockResolvedValue(mockPool);
    mockUserEstimate.totalEffectiveCollateral = 1000;
    mockUserEstimate.totalEffectiveLiabilities = 1100;
    mockUserEstimate.totalBorrowed = 1500;
    mockUserEstimate.totalSupplied = 2000;
    mockUser.positions = new Positions(
      new Map([[USDC_ID, 2000n]]),
      new Map([[XLM_ID, 3000n]]),
      new Map()
    );
    mockedSorobanHelper.loadUserPositionEstimate.mockResolvedValue({
      estimate: mockUserEstimate,
      user: mockUser,
    });
    mockedSorobanHelper.loadAuction.mockResolvedValue(undefined);
    mockedSorobanHelper.loadPoolOracle.mockResolvedValue(mockPoolOracle);
    const result = await checkUsersForLiquidationsAndBadDebt(
      db,
      mockedSorobanHelper,
      mockPool.id,
      user_ids
    );

    expect(result.length).toBe(1);
    expect(result).toEqual([
      {
        type: WorkSubmissionType.AuctionCreation,
        poolId: mockPool.id,
        auctionType: AuctionType.Liquidation,
        user: 'user1',
        auctionPercent: 100,
        bid: [USDC],
        lot: [XLM],
      },
    ]);
  });

  it('should handle partial user liquidations', async () => {
    const user_ids = ['user1'];
    mockedSorobanHelper.loadPool.mockResolvedValue(mockPool);
    mockUser.positions = new Positions(
      new Map([
        [USDC_ID, BigInt(2000e7)],
        [EURC_ID, BigInt(1000e7)],
      ]),
      new Map([
        [XLM_ID, BigInt(38000e7)],
        [EURC_ID, BigInt(500e7)],
      ]),
      new Map([])
    );
    mockUserEstimate = PositionsEstimate.build(mockPool, mockPoolOracle, mockUser.positions);
    mockedSorobanHelper.loadUserPositionEstimate.mockResolvedValue({
      estimate: mockUserEstimate,
      user: mockUser,
    });
    mockedSorobanHelper.loadAuction.mockResolvedValue(undefined);
    mockedSorobanHelper.loadPoolOracle.mockResolvedValue(mockPoolOracle);
    const result = await checkUsersForLiquidationsAndBadDebt(
      db,
      mockedSorobanHelper,
      mockPool.id,
      user_ids
    );

    expect(result.length).toBe(1);
    expect(result).toEqual([
      {
        type: WorkSubmissionType.AuctionCreation,
        poolId: mockPool.id,
        auctionType: AuctionType.Liquidation,
        user: 'user1',
        auctionPercent: 46,
        bid: [USDC],
        lot: [XLM],
      },
    ]);
  });

  it('should handle users with bad debt correctly', async () => {
    const user_ids = ['user1'];
    mockedSorobanHelper.loadPool.mockResolvedValue(mockPool);
    mockUserEstimate.totalEffectiveCollateral = 0;
    mockUserEstimate.totalEffectiveLiabilities = 1100;
    mockedSorobanHelper.loadUserPositionEstimate.mockResolvedValue({
      estimate: mockUserEstimate,
      user: mockUser,
    });
    mockedSorobanHelper.loadAuction.mockResolvedValue(undefined);

    const result = await checkUsersForLiquidationsAndBadDebt(
      db,
      mockedSorobanHelper,
      mockPool.id,
      user_ids
    );

    expect(result.length).toBe(1);
    expect(result).toEqual([
      { type: WorkSubmissionType.BadDebtTransfer, user: 'user1', poolId: mockPool.id },
    ]);
  });
});
