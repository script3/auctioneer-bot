import { AuctionData, PoolUser } from '@blend-capital/blend-sdk';
import { SorobanHelper } from '../src/utils/soroban_helper.js';
import {
  isLiquidatable,
  calculateLiquidationPercent,
  scanUsers,
} from '../src/liquidation_creator.js';
import { inMemoryAuctioneerDb, mockedFillerState } from './helpers/mocks';
import { AuctioneerDatabase } from '../src/utils/db';

describe('isLiquidatable', () => {
  let sorobanHelper: SorobanHelper;
  let user: PoolUser;
  beforeEach(() => {
    sorobanHelper = new SorobanHelper();
    user = mockedFillerState;
    user.positionEstimates.totalEffectiveCollateral = 25000;
    user.positionEstimates.totalEffectiveLiabilities = 1000;
  });

  it('returns true if the user health factor is below .99', async () => {
    user.positionEstimates.totalEffectiveCollateral = 1000;
    user.positionEstimates.totalEffectiveLiabilities = 1011;
    const result = await isLiquidatable(user);
    expect(result).toBe(true);
  });

  it('returns false if the user health facotr is above .99', async () => {
    user.positionEstimates.totalEffectiveCollateral = 1000;
    user.positionEstimates.totalEffectiveLiabilities = 1010;
    const result = await isLiquidatable(user);
    expect(result).toBe(false);
  });
});

describe('calculateLiquidationPercent', () => {
  let user: PoolUser;

  beforeEach(() => {
    user = mockedFillerState;
    user.positionEstimates.totalEffectiveCollateral = 0;
    user.positionEstimates.totalEffectiveLiabilities = 0;
    user.positionEstimates.totalBorrowed = 0;
    user.positionEstimates.totalSupplied = 0;
  });
  it('should calculate the correct liquidation percent for typical values', () => {
    user.positionEstimates.totalEffectiveCollateral = 1000;
    user.positionEstimates.totalEffectiveLiabilities = 1100;
    user.positionEstimates.totalBorrowed = 1500;
    user.positionEstimates.totalSupplied = 2000;
    const result = calculateLiquidationPercent(user);
    expect(Number(result)).toBe(62);
  });

  it('should calculate max of 100 percent liquidation size', () => {
    user.positionEstimates.totalEffectiveCollateral = 1700;
    user.positionEstimates.totalEffectiveLiabilities = 2200;
    user.positionEstimates.totalBorrowed = 1900;
    user.positionEstimates.totalSupplied = 2000;
    const result = calculateLiquidationPercent(user);

    expect(Number(result)).toBe(100);
  });

  it('should calculate the smallest possible liquidation size', () => {
    user.positionEstimates.totalEffectiveCollateral = 2199;
    user.positionEstimates.totalEffectiveLiabilities = 2200;
    user.positionEstimates.totalBorrowed = 1900;
    user.positionEstimates.totalSupplied = 10000000000000;
    const result = calculateLiquidationPercent(user);

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
    mockedFillerState.positionEstimates.totalEffectiveCollateral = 1000;
    mockedFillerState.positionEstimates.totalEffectiveLiabilities = 1100;
    mockedFillerState.positionEstimates.totalBorrowed = 1500;
    mockedFillerState.positionEstimates.totalSupplied = 2000;
    db.setUserEntry({
      user_id: mockedFillerState.user,
      health_factor:
        mockedFillerState.positionEstimates.totalEffectiveCollateral /
        mockedFillerState.positionEstimates.totalEffectiveLiabilities,
      collateral: new Map(),
      liabilities: new Map(),
      updated: 123,
    });
    jest.spyOn(sorobanHelper, 'loadUser').mockResolvedValue(mockedFillerState);
    jest.spyOn(sorobanHelper, 'loadAuction').mockResolvedValue(undefined);

    let liquidations = await scanUsers(db, sorobanHelper);
    expect(liquidations.length).toBe(1);
  });

  it('should not create a work submission for users with existing liquidation auctions', async () => {
    mockedFillerState.positionEstimates.totalEffectiveCollateral = 1000;
    mockedFillerState.positionEstimates.totalEffectiveLiabilities = 1100;
    mockedFillerState.positionEstimates.totalBorrowed = 1500;
    mockedFillerState.positionEstimates.totalSupplied = 2000;
    db.setUserEntry({
      user_id: mockedFillerState.user,
      health_factor:
        mockedFillerState.positionEstimates.totalEffectiveCollateral /
        mockedFillerState.positionEstimates.totalEffectiveLiabilities,
      collateral: new Map(),
      liabilities: new Map(),
      updated: 123,
    });
    jest.spyOn(sorobanHelper, 'loadUser').mockResolvedValue(mockedFillerState);
    jest
      .spyOn(sorobanHelper, 'loadAuction')
      .mockResolvedValue({ bid: new Map(), lot: new Map(), block: 123 });

    let liquidations = await scanUsers(db, sorobanHelper);
    expect(liquidations.length).toBe(0);
  });
});
