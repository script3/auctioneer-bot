import Database, { RunResult } from 'better-sqlite3';
import { parse, stringify } from './json.js';
import { logger } from './logger.js';

export interface StatusEntry {
  // The name of the status entry
  name: string;
  // The latest ledger number
  latest_ledger: number;
}

export interface UserEntry {
  // The user's address
  user_id: string;
  // The user's health factor
  health_factor: number;
  // The user's collateral
  collateral: Map<string, bigint>;
  // The user's liabilities
  liabilities: Map<string, bigint>;
  // The ledger this entry was last updated
  updated: number;
}

export enum AuctionType {
  Liquidation = 0,
  BadDebt = 1,
  Interest = 2,
}

export interface AuctionEntry {
  // The auction's source address
  user_id: string;
  // The auction's type
  auction_type: AuctionType;
  // The address for the filler of the auction
  filler: string;
  // The block the auction started
  start_block: number;
  // The estimated block the auction will be filled
  fill_block: number;
  // The ledger this entry was last updated
  updated: number;
}

export interface PriceEntry {
  // The asset's id
  asset_id: string;
  // The asset's price
  price: number;
  // The timestamp (in ms since epoch) this price was last updated
  timestamp: number;
}

export interface FilledAuctionEntry {
  // The transaction hash
  tx_hash: string;
  // The address that filled the auction
  filler: string;
  // The auction's source address
  user_id: string;
  // The auction's type
  auction_type: AuctionType;
  // The bid amounts
  bid: Map<string, bigint>;
  // The total bid amount
  bid_total: number;
  // The lot amounts
  lot: Map<string, bigint>;
  // The total lot amount
  lot_total: number;
  // The estimated profit
  est_profit: number;
  // The block the auction was filled
  fill_block: number;
  // The timestamp (in s since epoch) the auction was filled
  timestamp: string;
}

export class AuctioneerDatabase {
  db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  static connect(): AuctioneerDatabase {
    try {
      let db = new Database('./data/auctioneer.sqlite', { fileMustExist: true });
      return new AuctioneerDatabase(db);
    } catch (error) {
      logger.error(`Error connecting to database: ${error}`);
      throw error;
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch (error) {
      logger.error(`Error closing database: ${error}`);
      throw error;
    }
  }

  //********** Status Table **********//

  /**
   * Set the status entry for the given name. If the entry already exists, it will be replaced.
   * @param entry - The status entry to set
   * @returns The result of the sql operation
   */
  setStatusEntry(entry: StatusEntry): RunResult {
    try {
      return this.db
        .prepare('INSERT OR REPLACE INTO status (name, latest_ledger) VALUES (?, ?)')
        .run(entry.name, entry.latest_ledger);
    } catch (error: any) {
      logger.error(`Error setting status entry: ${error}`);
      throw error;
    }
  }

  /**
   * Get the status entry for the given name.
   * @param name - The name of the status entry
   * @returns The status entry or undefined if it does not exist
   */
  getStatusEntry(name: string): StatusEntry | undefined {
    try {
      return this.db.prepare('SELECT * FROM status WHERE name = ?').get(name) as
        | StatusEntry
        | undefined;
    } catch (error: any) {
      logger.error(`Error getting status entry: ${error}`);
      throw error;
    }
  }

  //********** Prices Table **********//

  /**
   * Set multiple price entries in the database in a single transaction.
   * If a price entry already exists, it will be replaced.
   * @param entries - An array of PriceEntry objects to set
   * @returns The result of the sql operation
   */
  setPriceEntries(entries: PriceEntry[]) {
    try {
      const insertStatement = this.db.prepare(
        'INSERT OR REPLACE INTO prices (asset_id, price, timestamp) VALUES (?, ?, ?)'
      );

      const priceEntryTx = this.db.transaction((priceEntries: PriceEntry[]) => {
        for (const entry of priceEntries) {
          insertStatement.run(entry.asset_id, entry.price, entry.timestamp);
        }
      });

      priceEntryTx(entries);
    } catch (error: any) {
      logger.error(`Error setting price entries: ${error}`);
      throw error;
    }
  }

  /**
   * Get a price entry in the database.
   * @param assetId - The address of the asset to get the price for
   * @returns The result of the sql operation
   */
  getPriceEntry(assetId: string): PriceEntry | undefined {
    try {
      return this.db.prepare('SELECT * FROM prices WHERE asset_id = ?').get(assetId) as
        | PriceEntry
        | undefined;
    } catch (error: any) {
      logger.error(`Error getting price entry: ${error}`);
      throw error;
    }
  }

  //********** User Table **********//

  /**
   * Set a user in the database. If the user already exists, it will be replaced.
   * @param entry - The user entry to set
   * @returns The result of the sql operation
   */
  setUserEntry(entry: UserEntry): RunResult {
    try {
      return this.db
        .prepare(
          'INSERT OR REPLACE INTO users (user_id, health_factor, collateral, liabilities, updated) VALUES (?, ?, ?, ?, ?)'
        )
        .run(
          entry.user_id,
          entry.health_factor,
          stringify(entry.collateral),
          stringify(entry.liabilities),
          entry.updated
        );
    } catch (error: any) {
      logger.error(`Error setting user entry: ${error}`);
      throw error;
    }
  }

  /**
   * Delete a user from the database.
   * @param user_id - The user's address
   * @returns The result of the sql operation
   */
  deleteUserEntry(user_id: string): RunResult {
    try {
      return this.db.prepare('DELETE FROM users WHERE user_id = ?').run(user_id);
    } catch (error: any) {
      logger.error(`Error deleting user entry: ${error}`);
      throw error;
    }
  }

  /**
   * Get a user from the database.
   * @param user_id - The user's address
   * @returns The user entry or undefined if it does not exist
   */
  getUserEntry(user_id: string): UserEntry | undefined {
    try {
      let entry: any = this.db.prepare('SELECT * FROM users WHERE user_id = ?').get(user_id);
      if (entry) {
        return {
          user_id: entry.user_id,
          health_factor: entry.balance,
          collateral: parse<Map<string, bigint>>(entry.collateral),
          liabilities: parse<Map<string, bigint>>(entry.liabilities),
          updated: entry.updated,
        } as UserEntry;
      }
      return undefined;
    } catch (error: any) {
      logger.error(`Error getting user entry: ${error}`);
      throw error;
    }
  }

  /**
   * Get all users in the database with a health factor under a certain value.
   * @param health_factor - The health factor to filter by
   * @returns An array user entries, or an empty array if none are found
   */
  getUserEntriesUnderHealthFactor(health_factor: number): UserEntry[] {
    try {
      let entries: any[] = this.db
        .prepare('SELECT * FROM users WHERE health_factor < ?')
        .all(health_factor);
      return entries.map((entry) => {
        return {
          user_id: entry.user_id,
          health_factor: entry.balance,
          collateral: parse<Map<string, bigint>>(entry.collateral),
          liabilities: parse<Map<string, bigint>>(entry.liabilities),
          updated: entry.updated,
        } as UserEntry;
      });
    } catch (error: any) {
      logger.error(`Error getting user entries under health factor: ${error}`);
      throw error;
    }
  }

  /**
   * Get all users in the database with a liability position for the given asset.
   * @param assetId - The asset to filter by
   * @returns An array user entries, or an empty array if none are found
   */
  getUserEntriesWithLiability(assetId: string): UserEntry[] {
    try {
      let entries: any[] = this.db
        .prepare('SELECT * FROM users WHERE json_extract(liabilities, ?) IS NOT NULL')
        .all(`'$.value.${assetId}'`);
      return entries.map((entry) => {
        return {
          user_id: entry.user_id,
          health_factor: entry.balance,
          collateral: parse<Map<string, bigint>>(entry.collateral),
          liabilities: parse<Map<string, bigint>>(entry.liabilities),
          updated: entry.updated,
        } as UserEntry;
      });
    } catch (error: any) {
      logger.error(`Error getting user entries with liability: ${error}`);
      throw error;
    }
  }

  /**
   * Get all users in the database with a collateral position for the given asset.
   * @param assetId - The asset to filter by
   * @returns An array user entries, or an empty array if none are found
   */
  getUserEntriesWithCollateral(assetId: string): UserEntry[] {
    try {
      let entries: any[] = this.db
        .prepare('SELECT * FROM users WHERE json_extract(collateral, ?) IS NOT NULL')
        .all(`'$.value.${assetId}'`);
      return entries.map((entry) => {
        return {
          user_id: entry.user_id,
          health_factor: entry.balance,
          collateral: parse<Map<string, bigint>>(entry.collateral),
          liabilities: parse<Map<string, bigint>>(entry.liabilities),
          updated: entry.updated,
        } as UserEntry;
      });
    } catch (error: any) {
      logger.error(`Error getting user entries with collateral: ${error}`);
      throw error;
    }
  }

  //********** Auction Table **********//

  /**
   * Set an auction in the database.
   * @param entry - The auction entry to set
   * @returns The result of the sql operation
   */
  setAuctionEntry(entry: AuctionEntry): RunResult {
    try {
      return this.db
        .prepare(
          'INSERT INTO auctions (user_id, auction_type, filler, start_block, fill_block, updated) VALUES (?, ?, ?, ?, ?, ?)'
        )
        .run(
          entry.user_id,
          entry.auction_type,
          entry.filler,
          entry.start_block,
          entry.fill_block,
          entry.updated
        );
    } catch (error: any) {
      logger.error(`Error setting auction entry: ${error}`);
      throw error;
    }
  }

  /**
   * Delete an auction from the database.
   *
   * This does nothing if the auction does not exist.
   *
   * @param user_id - The auction's source address
   * @param auction_type - The auction's type
   * @returns The result of the sql operation
   */
  deleteAuctionEntry(user_id: string, auction_type: AuctionType): RunResult {
    try {
      return this.db
        .prepare('DELETE FROM auctions WHERE user_id = ? AND auction_type = ?')
        .run(user_id, auction_type);
    } catch (error: any) {
      logger.error(`Error deleting auction entry: ${error}`);
      throw error;
    }
  }

  /**
   * Get all ongoing auction from the database.
   * @param user_id - The auction's source address
   * @param auction_type - The auction's type
   * @returns The result of the sql operation
   */
  getAllAuctionEntries(): AuctionEntry[] {
    try {
      let entries: any[] = this.db.prepare('SELECT * FROM auctions').all();
      return entries.map((entry) => {
        return {
          user_id: entry.user_id,
          auction_type: entry.auction_type,
          filler: entry.filler,
          start_block: entry.start_block,
          fill_block: entry.fill_block,
          updated: entry.updated,
        } as AuctionEntry;
      });
    } catch (error: any) {
      logger.error(`Error getting all auction entries: ${error}`);
      throw error;
    }
  }

  //********** Filled Auction Table **********//

  /**
   * Set a filled auction in the database.
   * @param entry - The filled auction entry to set
   * @returns The result of the sql operation
   */
  setFilledAuctionEntry(entry: FilledAuctionEntry): RunResult {
    try {
      return this.db
        .prepare(
          'INSERT INTO filled_auctions (tx_hash, filler, user_id, auction_type, bid, bid_total, lot, lot_total, est_profit, fill_block, timestamp) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(
          entry.tx_hash,
          entry.filler,
          entry.user_id,
          entry.auction_type,
          stringify(entry.bid),
          entry.bid_total,
          stringify(entry.lot),
          entry.lot_total,
          entry.est_profit,
          entry.fill_block,
          entry.timestamp
        );
    } catch (error: any) {
      logger.error(`Error setting filled auction entry: ${error}`);
      throw error;
    }
  }
}
