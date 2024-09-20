// db.test.ts
import {
  AuctioneerDatabase,
  UserEntry,
  AuctionEntry,
  FilledAuctionEntry,
  AuctionType,
  StatusEntry,
  PriceEntry,
} from '../../src/utils/db.js';
import { parse, stringify } from '../../src/utils/json.js';
import { logger } from '../../src/utils/logger.js';
import { inMemoryAuctioneerDb } from '../helpers/mocks.js';

describe('AuctioneerDatabase', () => {
  let db: AuctioneerDatabase;

  beforeEach(() => {
    db = inMemoryAuctioneerDb();
  });

  afterEach(() => {
    db.close();
  });

  // Status functions tests
  test('setStatusEntry should add a new status entry', () => {
    const entry1: StatusEntry = {
      name: 'status1',
      latest_ledger: 123,
    };
    db.setStatusEntry(entry1);
    const entry2: StatusEntry = {
      name: 'status1',
      latest_ledger: 123,
    };
    db.setStatusEntry(entry2);
    const result = db.getStatusEntry(entry1.name);
    expect(result).toEqual(entry1);
  });

  test('getStatusEntry should return undefined for non-existing status entry', () => {
    const result = db.getStatusEntry('non-existing');
    expect(result).toBeUndefined();
  });

  test('setStatus should log an error if the query fails', () => {
    const error = new Error('Database error');
    const entry: StatusEntry = {
      name: 'status1',
      latest_ledger: 123,
    };
    // Mock the database to throw an error
    db.db.prepare = jest.fn().mockImplementation(() => {
      throw error;
    });
    // Mock the logger
    logger.error = jest.fn();

    expect(() => db.setStatusEntry(entry)).toThrow(error);
    expect(logger.error).toHaveBeenCalledWith(`Error setting status entry: ${error}`);
  });

  // Price functions tests
  test('setPriceEntries should add multiple price entries', () => {
    const entries: PriceEntry[] = [
      { asset_id: 'asset1', price: 100, timestamp: Date.now() },
      { asset_id: 'asset2', price: 200, timestamp: Date.now() },
    ];
    db.setPriceEntries(entries);
    const result1 = db.getPriceEntry('asset1');
    const result2 = db.getPriceEntry('asset2');
    expect(result1).toEqual(entries[0]);
    expect(result2).toEqual(entries[1]);
  });

  test('getPriceEntry should return undefined for non-existing price entry', () => {
    const result = db.getPriceEntry('non-existing');
    expect(result).toBeUndefined();
  });

  // User functions tests
  test('setUserEntry should add a new user entry', () => {
    const user1: UserEntry = {
      user_id: 'user1',
      health_factor: 1.0,
      collateral: new Map([['asset1', BigInt(100)]]),
      liabilities: new Map([['asset1', BigInt(50)]]),
      updated: Date.now(),
    };
    db.setUserEntry(user1);
    const user2: UserEntry = {
      user_id: 'user2',
      health_factor: 1.0,
      collateral: new Map([['asset1', BigInt(100)]]),
      liabilities: new Map([['asset1', BigInt(50)]]),
      updated: Date.now(),
    };
    db.setUserEntry(user2);
    const result = db.getUserEntry(user1.user_id);
    expect(result).toEqual(user1);
  });

  test('deleteUserEntry should remove an existing user entry', () => {
    const entry: UserEntry = {
      user_id: 'user1',
      health_factor: 1.0,
      collateral: new Map([['asset1', BigInt(100)]]),
      liabilities: new Map([['asset1', BigInt(50)]]),
      updated: Date.now(),
    };
    db.setUserEntry(entry);
    db.deleteUserEntry(entry.user_id);
    const result = db.getUserEntry(entry.user_id);
    expect(result).toBeUndefined();
  });

  test('getUserEntriesUnderHealthFactor should return users with health factor under a certain value', () => {
    const user1: UserEntry = {
      user_id: 'user1',
      health_factor: 0.5,
      collateral: new Map([['asset1', BigInt(100)]]),
      liabilities: new Map([['asset1', BigInt(50)]]),
      updated: Date.now(),
    };
    db.setUserEntry(user1);
    const user2: UserEntry = {
      user_id: 'user2',
      health_factor: 1.0,
      collateral: new Map([['asset1', BigInt(100)]]),
      liabilities: new Map([['asset1', BigInt(50)]]),
      updated: Date.now(),
    };
    db.setUserEntry(user2);
    const result = db.getUserEntriesUnderHealthFactor(1.0);
    expect(result).toContainEqual(user1);
  });

  test('getUserEntriesWithLiability should return users with a liability for a given asset', () => {
    const user1: UserEntry = {
      user_id: 'user1',
      health_factor: 1.0,
      collateral: new Map([['asset2', BigInt(100)]]),
      liabilities: new Map([['asset1', BigInt(50)]]),
      updated: Date.now(),
    };
    db.setUserEntry(user1);
    const user2: UserEntry = {
      user_id: 'use2',
      health_factor: 1.0,
      collateral: new Map([['asset2', BigInt(100)]]),
      liabilities: new Map([['asset2', BigInt(50)]]),
      updated: Date.now(),
    };
    db.setUserEntry(user2);
    const result = db.getUserEntriesWithLiability('asset1');
    expect(result).toContainEqual(user1);
  });

  test('getUserEntriesWithCollateral should return users with a collateral for a given asset', () => {
    const user1: UserEntry = {
      user_id: 'user1',
      health_factor: 1.0,
      collateral: new Map([['asset1', BigInt(100)]]),
      liabilities: new Map([['asset1', BigInt(50)]]),
      updated: Date.now(),
    };
    db.setUserEntry(user1);
    const user2: UserEntry = {
      user_id: 'user2',
      health_factor: 1.0,
      collateral: new Map([['asset2', BigInt(100)]]),
      liabilities: new Map([['asset1', BigInt(50)]]),
      updated: Date.now(),
    };
    db.setUserEntry(user2);
    const result = db.getUserEntriesWithCollateral('asset1');
    expect(result).toContainEqual(user1);
  });

  test('getUserEntriesUpdatedBefore should return users updated before a certain ledger', () => {
    const user1: UserEntry = {
      user_id: 'user1',
      health_factor: 1.0,
      collateral: new Map([['asset1', BigInt(100)]]),
      liabilities: new Map([['asset1', BigInt(50)]]),
      updated: 100,
    };
    db.setUserEntry(user1);
    const user2: UserEntry = {
      user_id: 'user2',
      health_factor: 1.0,
      collateral: new Map([['asset1', BigInt(100)]]),
      liabilities: new Map([['asset1', BigInt(50)]]),
      updated: 200,
    };
    db.setUserEntry(user2);
    const result = db.getUserEntriesUpdatedBefore(200);
    expect(result).toContainEqual(user1);
  });

  // Auction functions tests
  test('setAuctionEntry should add a new auction entry', () => {
    const entry: AuctionEntry = {
      user_id: 'user1',
      auction_type: AuctionType.Liquidation,
      filler: 'filler1',
      start_block: 100,
      fill_block: 200,
      updated: Date.now(),
    };
    db.setAuctionEntry(entry);
    const result = db.getAllAuctionEntries();
    expect(result).toContainEqual(entry);
  });

  // Auction functions tests
  test('getAuctionEntry should return the correct auction entry', () => {
    const entry: AuctionEntry = {
      user_id: 'user1',
      auction_type: AuctionType.Liquidation,
      filler: 'filler1',
      start_block: 100,
      fill_block: 200,
      updated: Date.now(),
    };
    db.setAuctionEntry(entry);
    const result = db.getAuctionEntry(entry.user_id, entry.auction_type);
    expect(result).toEqual(entry);
  });

  test('getAuctionEntry should return undefined for non-existing auction entry', () => {
    const result = db.getAuctionEntry('non-existing', AuctionType.Liquidation);
    expect(result).toBeUndefined();
  });

  test('deleteAuctionEntry should remove an existing auction entry', () => {
    const entry1: AuctionEntry = {
      user_id: 'user1',
      auction_type: AuctionType.Liquidation,
      filler: 'filler1',
      start_block: 100,
      fill_block: 200,
      updated: Date.now(),
    };
    db.setAuctionEntry(entry1);
    const entry2: AuctionEntry = {
      user_id: 'user1',
      auction_type: AuctionType.Liquidation,
      filler: 'filler1',
      start_block: 100,
      fill_block: 200,
      updated: Date.now(),
    };
    db.setAuctionEntry(entry2);
    db.deleteAuctionEntry(entry1.user_id, entry1.auction_type);
    const result = db.getAllAuctionEntries();
    expect(result).not.toContainEqual(entry1);
  });

  // Filled Auction functions tests
  test('setFilledAuctionEntry should add a new filled auction entry', () => {
    const entry: FilledAuctionEntry = {
      tx_hash: 'tx1',
      filler: 'filler1',
      user_id: 'user1',
      auction_type: AuctionType.Liquidation,
      bid: new Map([['asset1', BigInt(100)]]),
      bid_total: 100,
      lot: new Map([['asset1', BigInt(50)]]),
      lot_total: 50,
      est_profit: 50,
      fill_block: 200,
      timestamp: 12345,
    };
    db.setFilledAuctionEntry(entry);
    // Add a method to get filled auction entries if not present
    const result = db.db
      .prepare('SELECT * FROM filled_auctions WHERE tx_hash = ?')
      .get(entry.tx_hash) as any;
    expect({
      tx_hash: result.tx_hash,
      filler: result.filler,
      user_id: result.user_id,
      auction_type: result.auction_type,
      bid: parse<Map<string, bigint>>(result.bid),
      bid_total: entry.bid_total,
      lot: parse<Map<string, bigint>>(result.lot),
      lot_total: result.lot_total,
      est_profit: result.est_profit,
      fill_block: result.fill_block,
      timestamp: result.timestamp,
    }).toEqual(entry);
  });

  test('getAllAuctionEntries should return all auction entries', () => {
    const entries: AuctionEntry[] = [
      {
        user_id: 'user1',
        auction_type: AuctionType.Liquidation,
        filler: 'filler1',
        start_block: 100,
        fill_block: 200,
        updated: Date.now(),
      },
      {
        user_id: 'user2',
        auction_type: AuctionType.Liquidation,
        filler: 'filler2',
        start_block: 101,
        fill_block: 201,
        updated: Date.now(),
      },
    ];

    // Mock the database response
    db.db.prepare = jest.fn().mockReturnValue({
      all: jest.fn().mockReturnValue(entries),
    });

    const result = db.getAllAuctionEntries();
    expect(result).toEqual(entries);
  });

  test('getAllAuctionEntries should log an error and throw if the query fails', () => {
    const error = new Error('Database error');

    // Mock the database to throw an error
    db.db.prepare = jest.fn().mockReturnValue({
      all: jest.fn().mockImplementation(() => {
        throw error;
      }),
    });

    // Mock the logger
    logger.error = jest.fn();

    expect(() => db.getAllAuctionEntries()).toThrow(error);
    expect(logger.error).toHaveBeenCalledWith(`Error getting all auction entries: ${error}`);
  });
});
