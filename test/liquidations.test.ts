import { PositionsEstimate } from '@blend-capital/blend-sdk';
import { calculateLiquidationPercent, isLiquidatable, scanUsers } from '../src/liquidations.js';
import { AuctioneerDatabase } from '../src/utils/db.js';
import { SorobanHelper } from '../src/utils/soroban_helper.js';
import { inMemoryAuctioneerDb, mockPoolUser, mockPoolUserEstimate } from './helpers/mocks.js';

describe('isLiquidatable', () => {
  let sorobanHelper: SorobanHelper;
  let userEstimate: PositionsEstimate;
  beforeEach(() => {
    sorobanHelper = new SorobanHelper();
    userEstimate = mockPoolUserEstimate;
    userEstimate.totalEffectiveCollateral = 25000;
    userEstimate.totalEffectiveLiabilities = 1000;
  });

  it('returns true if the userEstimate health factor is below .99', async () => {
    userEstimate.totalEffectiveCollateral = 1000;
    userEstimate.totalEffectiveLiabilities = 1011;
    const result = await isLiquidatable(userEstimate);
    expect(result).toBe(true);
  });

  it('returns false if the userEstimate health facotr is above .99', async () => {
    userEstimate.totalEffectiveCollateral = 1000;
    userEstimate.totalEffectiveLiabilities = 1010;
    const result = await isLiquidatable(userEstimate);
    expect(result).toBe(false);
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
  let sorobanHelper: SorobanHelper;

  beforeEach(() => {
    db = inMemoryAuctioneerDb();
    sorobanHelper = new SorobanHelper();
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
    jest
      .spyOn(sorobanHelper, 'loadUserPositionEstimate')
      .mockResolvedValue({ estimate: mockPoolUserEstimate, user: mockPoolUser });
    jest.spyOn(sorobanHelper, 'loadAuction').mockResolvedValue(undefined);

    let liquidations = await scanUsers(db, sorobanHelper);
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
    jest
      .spyOn(sorobanHelper, 'loadUserPositionEstimate')
      .mockResolvedValue({ estimate: mockPoolUserEstimate, user: mockPoolUser });
    jest
      .spyOn(sorobanHelper, 'loadAuction')
      .mockResolvedValue({ bid: new Map(), lot: new Map(), block: 123 });

    let liquidations = await scanUsers(db, sorobanHelper);
    expect(liquidations.length).toBe(0);
  });
});
