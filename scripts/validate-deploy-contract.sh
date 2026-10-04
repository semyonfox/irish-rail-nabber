#!/usr/bin/env bash
set -euo pipefail

required_files=(
  .dockerignore
  Dockerfile
  daemon.py
  bus_daemon.py
  docker-compose.yml
  docker-entrypoint.sh
  migrations/001_severity2_schema_updates.sql
  migrations/002_add_train_date_to_station_events.sql
  migrations/003_drop_unused_indexes.sql
  migrations/004_add_users_and_auth.sql
  migrations/005_add_hacon_snapshots.sql
  migrations/006_add_api_daily_usage.sql
  migrations/007_query_performance.sql
  migrations/008_delay_history_rollups.sql
  migrations/009_clerk_auth.sql
  migrations/010_polar_billing.sql
  migrations/011_bus_gtfs.sql
  migrations/012_bus_shapes.sql
  migrations/013_remove_unused_bus_indexes.sql
  migrations/014_bus_observation_archive.sql
  migrations/015_bus_working_tables.sql
  migrations/016_retire_legacy_bus_stop_updates.sql
  requirements.txt
  schema.sql
  api/Cargo.toml
  api/Cargo.lock
  api/Dockerfile
  api/src/main.rs
  dashboard/Dockerfile
  dashboard/nginx.conf
  dashboard/package.json
  dashboard/pnpm-lock.yaml
)

for required_file in "${required_files[@]}"; do
  if [ ! -r "$required_file" ]; then
    echo "Missing deployment input: $required_file" >&2
    exit 1
  fi
done

if [ ! -d migrations ]; then
  echo "Missing deployment input directory: migrations" >&2
  exit 1
fi

grep -Fq 'route("/health"' api/src/main.rs
grep -Fxq '!bus_daemon.py' .dockerignore
grep -Fq 'COPY bus_daemon.py .' Dockerfile
grep -Fq '  bus-daemon:' docker-compose.yml
grep -Fq '  migrate:' docker-compose.yml
grep -Fq 'COPY nginx.conf /etc/nginx/conf.d/default.conf' dashboard/Dockerfile
grep -Fq 'apk add --no-cache wget' dashboard/Dockerfile
grep -Fq 'HEALTHCHECK' dashboard/Dockerfile

echo "Deployment contract valid: ${#required_files[@]} inputs"
