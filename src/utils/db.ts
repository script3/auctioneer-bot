import Database, { RunResult } from 'better-sqlite3';
import { parse, stringify } from './json.js';

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

export class AuctioneerDatabase {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  static connect(): AuctioneerDatabase {
    let db = new Database('./data/auctioneer.sqlite');
    db.pragma('journal_mode = WAL');
    return new AuctioneerDatabase(db);
  }

  close(): void {
    this.db.close();
  }

  // @dev: Temp
  insertTransaction(timestamp: string): number {
    const run_result = this.db
      .prepare('INSERT INTO transactions (timestamp) VALUES (?)')
      .run(timestamp);
    return run_result.lastInsertRowid as number;
  }

  // @dev: Temp
  getTransaction(id: number): { id: number; timestamp: string } | undefined {
    return this.db.prepare('SELECT * FROM transactions WHERE id = ?').get(id) as
      | { id: number; timestamp: string }
      | undefined;
  }

  //********** Status Table **********//

  /**
   * Set the status entry for the given name. If the entry already exists, it will be replaced.
   * @param entry - The status entry to set
   * @returns The result of the sql operation
   */
  setStatusEntry(entry: StatusEntry): RunResult {
    return this.db
      .prepare('INSERT OR REPLACE INTO status (name, latest_ledger) VALUES (?, ?)')
      .run(entry.name, entry.latest_ledger);
  }

  /**
   * Get the status entry for the given name.
   * @param name - The name of the status entry
   * @returns The status entry or undefined if it does not exist
   */
  getStatusEntry(name: string): StatusEntry | undefined {
    return this.db.prepare('SELECT * FROM status WHERE name = ?').get(name) as
      | StatusEntry
      | undefined;
  }

  //********** User Table **********//

  /**
   * Set a user in the database. If the user already exists, it will be replaced.
   * @param entry - The user entry to set
   * @returns The result of the sql operation
   */
  setUserEntry(entry: UserEntry): RunResult {
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
  }

  /**
   * Delete a user from the database.
   * @param user_id - The user's address
   * @returns The result of the sql operation
   */
  deleteUserEntry(user_id: string): RunResult {
    return this.db.prepare('DELETE FROM users WHERE user_id = ?').run(user_id);
  }

  /**
   * Get a user from the database.
   * @param user_id - The user's address
   * @returns The user entry or undefined if it does not exist
   */
  getUserEntry(user_id: string): UserEntry | undefined {
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
  }

  /**
   * Get all users in the database with a health factor under a certain value.
   * @param health_factor - The health factor to filter by
   * @returns An array user entries, or an empty array if none are found
   */
  getUserEntriesUnderHealthFactor(health_factor: number): UserEntry[] {
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
  }

  /**
   * Get all users in the database with a liability position for the given asset.
   * @param assetId - The asset to filter by
   * @returns An array user entries, or an empty array if none are found
   */
  getUserEntriesWithLiability(assetId: string): UserEntry[] {
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
  }

  /**
   * Get all users in the database with a collateral position for the given asset.
   * @param assetId - The asset to filter by
   * @returns An array user entries, or an empty array if none are found
   */
  getUserEntriesWithCollateral(assetId: string): UserEntry[] {
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
  }
}
