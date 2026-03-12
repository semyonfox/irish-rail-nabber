#!/bin/bash
set -e

export PGPASSWORD="$POSTGRES_PASSWORD"

# wait for database to be ready
echo "Waiting for TimescaleDB to be ready..."
until psql -h "db" -U "$POSTGRES_USER" -d "postgres" -c "SELECT 1" 2>/dev/null; do
  sleep 1
done

echo "Database is ready. Creating and initializing schema..."
psql -h "db" -U "$POSTGRES_USER" -d "postgres" -tc "SELECT 1 FROM pg_database WHERE datname = '${POSTGRES_DB}'" | grep -q 1 || \
    psql -h "db" -U "$POSTGRES_USER" -d "postgres" -c "CREATE DATABASE \"${POSTGRES_DB}\""

psql -h "db" -U "$POSTGRES_USER" -d "$POSTGRES_DB" < schema.sql

# run migrations in order (idempotent - uses IF NOT EXISTS / IF EXISTS)
if [ -d "/app/migrations" ]; then
  echo "Running migrations..."
  for migration in /app/migrations/*.sql; do
    if [ -f "$migration" ]; then
      echo "  Applying $(basename "$migration")..."
      psql -h "db" -U "$POSTGRES_USER" -d "$POSTGRES_DB" < "$migration"
    fi
  done
  echo "Migrations complete."
fi

echo "Schema initialized. Starting daemon..."
exec "$@"
