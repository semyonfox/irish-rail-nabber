# Deployment

The Jenkins candidate smoke test uses the temporary subnet `10.254.40.0/28`.
It was checked against the server's Docker networks and host routes on
14 September 2026. This avoids exhausted Docker default address pools; the
pipeline removes the candidate network after each test. Recheck overlap when
moving the job to another host. The production network is separate.

The repository includes `docker-compose.yml` for development. Production runs `/home/semyon/server-stacks/irish-rail/stack.yaml` with its private `stack.env`, fronted by Cloudflare Tunnel at `traein.semyon.ie`. Cloud options are below.

For backups and disaster recovery procedures see [Recovery](#backups-and-recovery).

## Compose services

```
db            timescale/timescaledb:2.25.2-pg18      database
migrate       irish-rail-nabber-daemon:latest        one-shot schema gate
daemon        irish-rail-nabber-daemon:latest        Python scraper
bus-daemon    irish-rail-nabber-daemon:latest        NTA bus collector
api           irish-rail-nabber-api:latest           Rust Axum
dashboard     irish-rail-nabber-dashboard:latest     nginx + static SPA
cloudflared   cloudflare/cloudflared:latest          edge tunnel
```

`db` is the only stateful service. Fresh PG18 stacks mount the named `postgres_data` volume at `/var/lib/postgresql`, which contains PG18's actual `PGDATA` directory. The one-shot `migrate` service must complete before either collector or the API starts, so bus startup does not depend on the unrelated Irish Rail healthcheck. The current production container predates the volume correction and must not be recreated until its anonymous volume is safely migrated. Everything else is stateless and can be rebuilt at will.

Service responsibilities are described in [architecture.md](architecture.md#service-responsibilities).

## Env template

Production env files must live in deployment secret storage, not in git. For the current server, start from `/home/semyon/server-stacks/irish-rail/stack.env.example`, save the populated file as `stack.env`, and keep it mode `600`. The repository's tracked `.env.production.example` is a safe reference for local or alternative deployments; never put real values in it. The production Compose command must always pass the private operator file with `--env-file`.

```bash
# database (use the same URL-encoded password in DATABASE_URL)
POSTGRES_USER=irish_data
POSTGRES_PASSWORD=<strong-random-password>
POSTGRES_DB=ireland_public
DATABASE_URL=postgresql://irish_data:<url-encoded-password>@db:5432/ireland_public

# NTA buses (obtain the key from the NTA developer portal)
NTA_API_KEY=<private-api-key>
NTA_GTFS_URL=https://www.transportforireland.ie/transitData/Data/GTFS_Realtime.zip
NTA_TRIP_UPDATES_URL=https://api.nationaltransport.ie/gtfsr/v2/gtfsr?format=json
NTA_VEHICLES_URL=https://api.nationaltransport.ie/gtfsr/v2/Vehicles?format=json
# NTA_GTFSR_URL is a deprecated fallback for NTA_TRIP_UPDATES_URL.
BUS_STATIC_REFRESH_SECONDS=86400
BUS_REALTIME_INTERVAL_SECONDS=60
BUS_REALTIME_RETENTION_DAYS=7

# auth
CLERK_PUBLISHABLE_KEY=pk_live_...
CLERK_SECRET_KEY=sk_live_...

# tier limits
API_RATE_LIMIT_FREE_TIER_LIMIT=25000
API_RATE_LIMIT_COFFEE_TIER_LIMIT=100000
API_RATE_LIMIT_UNLIMITED_ROLES=pro,admin
API_RATE_LIMIT_IP_SALT=<strong-random-value>

# chatbot LLM (OghmaNotes-compatible OpenAI-style endpoint)
LLM_API_URL=https://api.moonshot.ai/v1
LLM_API_KEY=<provider-key>
LLM_MODEL=kimi-k2.5
LLM_THINKING=off
LLM_TIMEOUT_MS=45000
LLM_MAX_TOKENS=1200
CHAT_MAX_TOOL_ITERATIONS=3
CHAT_MAX_TOOL_CALLS_PER_TURN=3
CHAT_TOOL_RESULT_MAX_CHARS=3500

# Alternative fallback names, if reusing an OpenAI-style env file instead:
# OPENAI_BASE_URL=https://api.openai.com
# OPENAI_API_KEY=<provider-key>
# CHAT_MODEL=gpt-4o-mini
# CHAT_REQUEST_TIMEOUT_SECONDS=45
# CHAT_MAX_TOKENS=1200

# billing (Polar.sh — primary, see auth-billing.md)
POLAR_CHECKOUT_ENABLED=false
POLAR_ACCESS_TOKEN=polar_oat_...
POLAR_WEBHOOK_SECRET=whsec_...
POLAR_ORGANIZATION_ID=...
POLAR_COFFEE_PRODUCT_ID=...
POLAR_PRO_PRODUCT_ID=...
POLAR_ENVIRONMENT=production

# edge
CLOUDFLARE_TUNNEL_TOKEN=...
```

Jenkins deploys the operator stack with `/home/semyon/server-stacks/irish-rail/stack.env`. It does not source the old Jenkins-specific env file. Keep all NTA, Clerk, Polar, LLM, rate-limit and tunnel values in the operator file instead of committing secrets.

Full description of each variable is in [auth-billing.md](auth-billing.md#polar-config-env) and [api.md](api.md#environment).

## Existing production rollout

```bash
cd /home/semyon/server-stacks/irish-rail
test -r stack.env
chmod 600 stack.env
test "$(docker inspect -f '{{.State.Health.Status}}' irish_rail_db)" = healthy
timeout 120 docker compose --env-file stack.env -f stack.yaml run --rm --no-deps migrate
docker compose --env-file stack.env -f stack.yaml up -d --no-build --no-deps daemon bus-daemon api dashboard
sleep 30
docker compose --env-file stack.env -f stack.yaml logs --tail=50
```

This is the existing-production rollout path. Create `stack.env` from `stack.env.example` only during initial setup; never overwrite the existing private production file during a rollout. Do not recreate the PG18 database container until its legacy anonymous data volume has been backed up and migrated to the corrected named-volume mount.

Verify the daemon is collecting and the API is up using the checklist in [testing.md](testing.md).

## Networking gotchas

### nftables blocks the docker bridge

If the daemon container cannot reach the upstream API but the host can, the cause is almost always host nftables dropping outbound TCP from the docker bridge subnet. Symptom: DNS resolves, every TCP connect times out, including to non-Irish hosts (try `docker exec daemon curl https://google.com`).

Fix options ranked by quality:

1. **Best**: add an nftables rule allowing the docker bridge subnet outbound. Survives docker upgrades, keeps container isolation.
2. **Good**: tell docker to manage nftables: `"iptables": false` in `/etc/docker/daemon.json`, then restart docker.
3. **Quick fix**: `network_mode: host` on the daemon in `docker-compose.yml`. Currently deployed. Breaks isolation but works while option 1 is pending.

### Cloudflare Tunnel

`cloudflared` is what exposes `traein.semyon.ie` without opening a port. The token is per-tunnel — manage tunnels at `https://one.dash.cloudflare.com/`. No nginx port publishes are needed on the host.

## Cloud options

Today's host is a home server. Cloud is on the table for uptime.

| Option | Cost | Uptime | When to use |
|--------|------|--------|-------------|
| Home server (today) | ~€0 | ~95% (power/ISP) | hobby phase |
| Railway only | $0–20/mo | ~98% | indie launch, single-cloud risk |
| Fly.io only | $0–15/mo | ~98% | better global edge |
| Railway primary + Fly.io failover | $30–40/mo | ~99.9% | once revenue justifies it |
| Multi-region AWS | $60–100/mo | ~99.9% | overkill until revenue ≥ €1k/mo |

Recommended trajectory:

1. **Now**: stay on the home server, keep Cloudflare Tunnel for the public endpoint.
2. **Phase 2 launch**: move daemon + DB to Railway hobby tier (free), keep dashboard on Vercel. Cost: $0. Eliminates power/ISP risk.
3. **€100/mo MRR**: add Fly.io secondary daemon, replicate DB. Cost: ~$30/mo.

See [ROADMAP.md](../ROADMAP.md) for revenue phasing.

## Backups and recovery

The private operator runbook holds emergency procedures. The production layout below is the current source of truth.

### Backup schedule

- `/etc/cron.d/server-stacks-backups` starts the production job hourly at minute `00` and daily at `02:00`.
- It writes custom-format PostgreSQL archives and matching cluster-globals SQL files under `/mnt/media/backups/irish-rail/postgres/`.
- Retention is 24 hourly, 14 daily, 8 weekly, 12 monthly, and yearly indefinitely. Weekly snapshots are copied on Sunday, monthly on day 1, and yearly on January 1.
- The repository's `backup-db.sh` uses a different legacy gzip/plain-SQL layout. It is not the production backup job or a recovery source of truth.

### Targets

| Metric | Target | Current |
|--------|--------|---------|
| RPO (max data loss) | < 1 h | Hourly archives observed; alerting still needs proof |
| RTO (recovery time) | < 15 min | Unknown until a timed disposable restore passes |

### Restore rehearsal

Do not rehearse against `ireland_public`. Restore into a disposable PostgreSQL 18 and TimescaleDB instance with the same extension version, using the PostgreSQL 18 client in that container. Timescale requires its pre/post-restore functions and does not support parallel `pg_restore` for this workflow.

```bash
ssh semyon@server
BACKUP=/mnt/media/backups/irish-rail/postgres/hourly/<verified-archive>.dump

# Run these against a disposable target, never irish_rail_db.
docker exec restore_test createdb -U irish_data ireland_public_restore_test
docker exec restore_test psql -v ON_ERROR_STOP=1 -U irish_data \
  -d ireland_public_restore_test \
  -c 'CREATE EXTENSION IF NOT EXISTS timescaledb; SELECT timescaledb_pre_restore();'
docker exec -i restore_test pg_restore --exit-on-error --no-owner --no-privileges \
  -U irish_data -d ireland_public_restore_test < "$BACKUP"
docker exec restore_test psql -v ON_ERROR_STOP=1 -U irish_data \
  -d ireland_public_restore_test \
  -c 'SELECT timescaledb_post_restore(); ANALYZE;'
```

Then run the verification queries from [testing.md](testing.md), record elapsed time, and remove only the explicitly named disposable target after review. See Timescale's [logical backup and restore procedure](https://docs.timescale.com/self-hosted/latest/backup-and-restore/logical-backup/) for the extension-specific contract.

### Monthly test

There is no automated restore-rehearsal command yet. Until a disposable restore is completed and recorded, catalog readability is verified but recoverability and the RTO are not.

## Logs

- `docker compose logs <service> --tail=200` for each container.
- Daemon uses JSON log driver, 10MB × 3 files retained.
- API logs through `tracing` to stdout (`RUST_LOG=irish_rail_api=info`).

## Migrations

Migrations are SQL files under `migrations/`, applied in numeric order. Apply on demand:

```bash
docker exec -i irish_rail_db psql -v ON_ERROR_STOP=1 -U irish_data -d ireland_public \
  < migrations/<NNN>_<name>.sql
```

Run migrations before switching the API image. New API code may query a column added by the same release, so starting API and daemon together can create a temporary 500-error window. The Jenkins deployment runs the candidate daemon once with `/bin/true`, waits for every SQL file to succeed, and only then recreates the services.

`schema.sql` (in the daemon image) idempotently creates the initial set on first boot. Anything past the initial schema is a numbered migration. The daemon invokes `psql` with `ON_ERROR_STOP`, so a failed statement aborts deployment instead of being reported as complete.

## Related docs

- [architecture.md](architecture.md) — service topology
- [scraper.md](scraper.md) — known networking issues, daemon behaviour
- [buses.md](buses.md) — NTA access, collector limits, and bus verification
- [api.md](api.md) — Rust service env
- [auth-billing.md](auth-billing.md) — Clerk and Polar environment
- [testing.md](testing.md) — post-deploy verification
- [../ROADMAP.md](../ROADMAP.md) — when to scale up
