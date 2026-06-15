#!/bin/bash
# Irish Rail Database Backup Script
# Hourly backups (keep 6) + Daily backups (keep indefinitely)

set -e

# Configuration
# Note: Database is in Docker container, use docker exec to connect
DB_HOST="localhost"
DB_PORT="5432"
DB_USER="irish_data"
DB_PASSWORD="secure_password"
DB_NAME="ireland_public"
DB_CONTAINER="irish_rail_db"
BACKUP_DIR="/home/semyon/code/personal/irish-rail-nabber/backups"
HOURLY_DIR="$BACKUP_DIR/hourly"
DAILY_DIR="$BACKUP_DIR/daily"
LOG_FILE="$BACKUP_DIR/backup.log"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

backup_database() {
    local backup_type=$1
    local backup_dir=$2
    local timestamp=$(date '+%Y%m%d_%H%M%S')
    
    if [ "$backup_type" = "hourly" ]; then
        filename="ireland_public_${timestamp}.sql.gz"
        max_files=6
    else
        filename="ireland_public_daily_$(date '+%Y%m%d').sql.gz"
        max_files=999  # keep all daily backups
    fi
    
    backup_file="$backup_dir/$filename"
    
    log "Starting $backup_type backup: $filename"
    
    # Perform the dump via Docker exec
    log "Connecting via docker exec to $DB_CONTAINER..."
    docker exec "$DB_CONTAINER" pg_dump \
        -h "$DB_HOST" \
        -p "$DB_PORT" \
        -U "$DB_USER" \
        -d "$DB_NAME" \
        --no-password \
        --format=plain \
        2>&1 | gzip -9 > "$backup_file"
    
    log "Backup file created, verifying..."
    
    if [ -f "$backup_file" ]; then
        size=$(du -h "$backup_file" | cut -f1)
        log "${GREEN}✓ $backup_type backup successful: $filename ($size)${NC}"
    else
        log "${RED}✗ $backup_type backup FAILED: $filename${NC}"
        return 1
    fi
    
    # Cleanup old backups (keep only the last N)
    cleanup_old_backups "$backup_dir" "$max_files"
}

cleanup_old_backups() {
    local backup_dir=$1
    local max_files=$2
    
    # Count current backups
    local file_count=$(ls -1 "$backup_dir"/*.sql.gz 2>/dev/null | wc -l)
    
    if [ "$file_count" -gt "$max_files" ]; then
        local to_delete=$((file_count - max_files))
        log "Cleaning up $to_delete old backup(s) (keeping $max_files)"
        
        # Delete oldest files
        ls -1t "$backup_dir"/*.sql.gz 2>/dev/null | tail -n "$to_delete" | while read file; do
            size=$(du -h "$file" | cut -f1)
            rm -f "$file"
            log "Deleted old backup: $(basename $file) ($size)"
        done
    fi
}

# Main execution
main() {
    if [ "$1" = "hourly" ] || [ -z "$1" ]; then
        backup_database "hourly" "$HOURLY_DIR"
    fi
    
    if [ "$1" = "daily" ]; then
        backup_database "daily" "$DAILY_DIR"
    fi
    
    if [ "$1" = "all" ]; then
        backup_database "hourly" "$HOURLY_DIR"
        backup_database "daily" "$DAILY_DIR"
    fi
    
    log "${GREEN}Backup process complete${NC}"
}

# Run main function
main "$1"
