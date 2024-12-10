#!/bin/bash

# Initialize variables
CATCHUP=false

# Parse arguments
while [[ "$#" -gt 0 ]]; do
  case $1 in
    --catchup) CATCHUP=true ;;
    *) echo "Unknown parameter passed: $1"; exit 1 ;;
  esac
  shift
done

# Log versions of container
echo "Node version: $(node -v)"
echo "NPM version: $(npm -v)"
echo "SQLite version: $(sqlite3 --version)"

# Verify node configuration files are present
if ! test -f ./data/config.json; then
  echo "No config.json file found in /app/data. Aborting."
  exit 1
fi

echo "Env file found."

# Initialize the database
sqlite3 ./data/auctioneer.sqlite < ./init_db.sql

echo "Database initialized."

# Make a directory to store the logs at /app/data/logs if it does not exist
if ! test -d ./data/logs; then
  mkdir ./data/logs
  echo "Created logs directory."
fi

echo "Setup complete."

echo "Starting auctioneer..."

# Start the app with optional --catchup flag
exec node --trace-deprecation ./lib/main.js $([ "$CATCHUP" = true ] && echo "--catchup")