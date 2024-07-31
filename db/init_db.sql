-- Create the database schema
CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL
);

-- Set WAL mode
PRAGMA journal_mode = WAL;