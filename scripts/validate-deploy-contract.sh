#!/usr/bin/env bash
set -euo pipefail

required_files=(
  Dockerfile
  daemon.py
  docker-entrypoint.sh
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
grep -Fq 'COPY nginx.conf /etc/nginx/conf.d/default.conf' dashboard/Dockerfile
grep -Fq 'apk add --no-cache wget' dashboard/Dockerfile
grep -Fq 'HEALTHCHECK' dashboard/Dockerfile

echo "Deployment contract valid: ${#required_files[@]} inputs"
