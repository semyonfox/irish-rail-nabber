#!/bin/bash
set -e

# Wait for database to be ready
echo "Waiting for TimescaleDB to be ready..."
until psql -h "db" -U "$POSTGRES_USER" -d "postgres" -c "SELECT 1" 2>/dev/null; do
  sleep 1
done

echo "Database is ready. Creating and initializing schema..."
psql -h "db" -U "$POSTGRES_USER" -d "postgres" -tc "SELECT 1 FROM pg_database WHERE datname = '${POSTGRES_DB}'" | grep -q 1 || \
    psql -h "db" -U "$POSTGRES_USER" -d "postgres" -c "CREATE DATABASE \"${POSTGRES_DB}\""

psql -h "db" -U "$POSTGRES_USER" -d "$POSTGRES_DB" < schema.sql

echo "Schema initialized. Starting daemon..."
exec "$@"
