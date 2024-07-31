import Database from "better-sqlite3";

export class AuctioneerDatabase {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  static connect(): AuctioneerDatabase {
    let db = new Database("./data/auctioneer.sqlite");
    db.pragma("journal_mode = WAL");
    return new AuctioneerDatabase(db);
  }

  close(): void {
    this.db.close();
  }

  insertTransaction(timestamp: string): number {
    const run_result = this.db
      .prepare("INSERT INTO transactions (timestamp) VALUES (?)")
      .run(timestamp);
    return run_result.lastInsertRowid as number;
  }

  getTransaction(id: number): { id: number; timestamp: string } | undefined {
    return this.db
      .prepare("SELECT * FROM transactions WHERE id = ?")
      .get(id) as { id: number; timestamp: string } | undefined;
  }
}
