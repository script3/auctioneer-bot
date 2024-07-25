#!/bin/bash

MAX_RETRIES=5
RETRY_INTERVAL=5

start_rabbitmq() {
    rabbitmq-server -detached
    for i in {1..10}; do
        if rabbitmqctl status >/dev/null 2>&1; then
            echo "RabbitMQ started successfully"
            return 0
        fi
        sleep 1
    done
    echo "Failed to start RabbitMQ"
    return 1
}

monitor_rabbitmq() {
    local retry_count=0
    while true; do
        if ! rabbitmqctl status >/dev/null 2>&1; then
            echo "RabbitMQ is down. Attempting to restart..."
            rabbitmqctl stop >/dev/null 2>&1
            if start_rabbitmq; then
                echo "RabbitMQ restarted successfully"
                retry_count=0
            else
                retry_count=$((retry_count + 1))
                echo "Failed to restart RabbitMQ. Attempt $retry_count of $MAX_RETRIES"
                if [ $retry_count -ge $MAX_RETRIES ]; then
                    echo "Failed to restart RabbitMQ after $MAX_RETRIES attempts. Aborting."
                    return 1
                fi
            fi
        fi
        sleep $RETRY_INTERVAL
    done
}

# Set the config file path for rabbitmq
if test -f /app/data/rabbitmq.conf; then
  echo "User provided rabbitmq.conf file found in /app/data. Replacing default config file."
  cp /app/data/rabbitmq.conf /etc/rabbitmq/rabbitmq.conf
fi

# Verify node configuration files are present
if ! test -f /app/data/.env; then
  echo "No .env file found in /app/data. Aborting."
  exit 1
fi
# Copy the .env file to the app directory so pm2 can find it
cp /app/data/.env /app/.env

# Initialize the database
sqlite3 /app/data/auctioneer.sqlite < /app/init_db.sql

# Start RabbitMQ
if ! start_rabbitmq; then
    echo "Initial RabbitMQ start failed. Aborting."
    exit 1
fi

# Start RabbitMQ monitoring in the background
monitor_rabbitmq &

# Start Node.js processes with pm2 in the background
pm2-runtime app.config.cjs &

# Wait for any background process to exit
wait -n

# If we reach here, either the monitor or pm2-runtime process has exited
echo "A critical process has exited. Shutting down the container."
exit 1