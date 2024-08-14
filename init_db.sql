-- Create the database schema

-- Table to store the status of the different components of the application
CREATE TABLE IF NOT EXISTS status (
    name TEXT PRIMARY KEY NOT NULL,
    latest_ledger INTEGER NOT NULL
);

-- Table to store the user's that have positions in the pool
CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY NOT NULL,
    health_factor REAL NOT NULL,
    collateral JSON NOT NULL,
    liabilities JSON,
    updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_health_factor ON users(health_factor);

-- Table to store prices of assets as defined by the bot
CREATE TABLE IF NOT EXISTS prices (
    asset_id TEXT PRIMARY KEY NOT NULL,
    price REAL NOT NULL,
    updated INTEGER NOT NULL
);

-- Table to store ongoing auctions
CREATE TABLE IF NOT EXISTS auctions (
    user_id TEXT NOT NULL,
    auction_type INTEGER NOT NULL,
    filler TEXT NOT NULL,
    start_block INTEGER NOT NULL,
    fill_block INTEGER NOT NULL,
    updated INTEGER NOT NULL,
    PRIMARY KEY (user_id, auction_type)
);

-- Table to store filled auctions
CREATE TABLE IF NOT EXISTS filled_auctions (
    tx_hash TEXT PRIMARY KEY,
    filler TEXT NOT NULL,
    user_id TEXT NOT NULL,
    auction_type INTEGER NOT NULL,
    bid JSON NOT NULL,
    bid_total REAL NOT NULL,
    lot JSON NOT NULL,
    lot_total REAL NOT NULL,
    est_profit REAL NOT NULL,
    fill_block INTEGER NOT NULL,
    timestamp TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_filler ON filled_auctions(filler);
