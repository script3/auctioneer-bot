import sqlite3 from "sqlite3";

export function connectToDb(): sqlite3.Database {
  return new sqlite3.Database("./data/auctioneer.sqlite", (err) => {
    if (err) {
      console.error("Error connecting to database", err);
      throw err;
    }
  });
}
