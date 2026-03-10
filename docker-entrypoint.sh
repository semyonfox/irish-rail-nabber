#!/bin/bash
set -e

# Wait for database to be ready
echo "Waiting for TimescaleDB to be ready..."
until psql -h "db" -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT 1" 2>/dev/null; do
  sleep 1
done

echo "Database is ready. Initializing schema..."
psql -h "db" -U "$POSTGRES_USER" -d "$POSTGRES_DB" < schema.sql

echo "Schema initialized. Starting daemon..."
exec "$@"
