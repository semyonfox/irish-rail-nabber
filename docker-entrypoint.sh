#!/bin/bash
set -e

: "${DATABASE_URL:?set DATABASE_URL}"

# wait for database to be ready
echo "Waiting for TimescaleDB to be ready..."
until psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -c "SELECT 1" >/dev/null 2>&1; do
  sleep 1
done

if [ "${SKIP_DB_MIGRATIONS:-0}" != "1" ]; then
  echo "Database is ready. Initializing schema..."
  psql -v ON_ERROR_STOP=1 "$DATABASE_URL" < schema.sql

  # run migrations in order (idempotent - uses IF NOT EXISTS / IF EXISTS)
  if [ -d "/app/migrations" ]; then
    echo "Running migrations..."
    for migration in /app/migrations/*.sql; do
      if [ -f "$migration" ]; then
        echo "  Applying $(basename "$migration")..."
        psql -v ON_ERROR_STOP=1 "$DATABASE_URL" < "$migration"
      fi
    done
    echo "Migrations complete."
  fi
else
  echo "Database is ready. Migrations already completed by the migrate service."
fi

echo "Starting process..."
exec "$@"
