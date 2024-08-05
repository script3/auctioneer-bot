-- Create the database schema

-- @dev: test table - remove once app is complete
CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL
);

-- Table to store the status of the different components of the application
CREATE TABLE IF NOT EXISTS status (
    name TEXT PRIMARY KEY,
    latest_ledger INTEGER NOT NULL
);

-- Table to store the user's that have positions in the pool
CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    health_factor REAL NOT NULL,
    collateral JSON NOT NULL,
    liabilities JSON,
    updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_health_factor ON users(health_factor);

-- Set WAL mode
PRAGMA journal_mode = WAL;