#!/bin/bash
# Backup script for Irish Rail database
# Run this from a machine with PostgreSQL client tools installed
# or from the Docker container

set -e

DB_HOST="${1:-10.0.0.5}"
DB_PORT="${2:-9898}"
DB_USER="${3:-irish_data}"
DB_NAME="${4:-ireland_public}"

BACKUP_FILE="ireland_public_backup_$(date +%Y%m%d_%H%M%S).dump"

echo "Creating backup of $DB_NAME from $DB_HOST:$DB_PORT..."
echo "Output: $BACKUP_FILE"

pg_dump -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
  --format=custom --compress=9 \
  --file="$BACKUP_FILE"

if [ $? -eq 0 ]; then
    SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
    echo "✅ Backup completed: $BACKUP_FILE ($SIZE)"
else
    echo "❌ Backup failed!"
    exit 1
fi
