#!/bin/bash

# Default values
POOL_ID=""

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -p|--prev-pool-id)
            POOL_ID="$2"
            shift 2
            ;;
        *)
            # Skip unknown arguments
            shift
            ;;
    esac
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

# Set up the database
./db/setup_db.sh -p $POOL_ID
if [ $? -ne 0 ]; then
      exit 1
fi

# Make a directory to store the logs at /app/data/logs if it does not exist
if ! test -d ./data/logs; then
  mkdir ./data/logs
  echo "Created logs directory."
fi

echo "Setup complete."

echo "Starting auctioneer..."

# Start the app
node ./lib/main.js