# Deployment

The stack runs from a single `docker-compose.yml`. Production today is a home server fronted by Cloudflare Tunnel at `traein.semyon.ie`. Cloud options below.

For backups and disaster recovery procedures see [Recovery](#backups-and-recovery).

## Compose services

```
db            timescale/timescaledb:2.25.2-pg18      database
daemon        irish-rail-nabber-daemon:latest        Python scraper
api           irish-rail-nabber-api:latest           Rust Axum
dashboard     irish-rail-nabber-dashboard:latest     nginx + static SPA
cloudflared   cloudflare/cloudflared:latest          edge tunnel
```

`db` is the only stateful service (volume `postgres_data`). Everything else is stateless and can be rebuilt at will.

Service responsibilities are described in [architecture.md](architecture.md#service-responsibilities).

## Env template

Drop this in `.env.local` on the server (and adjust). The file is gitignored.

```bash
# database (used by db, daemon, api)
POSTGRES_USER=irish_data
POSTGRES_PASSWORD=<strong-random>
POSTGRES_DB=ireland_public
DATABASE_URL=postgres://irish_data:<strong-random>@db:5432/ireland_public

# auth
JWT_SECRET=<openssl rand -hex 32>
JWT_ACCESS_EXPIRY=900
JWT_REFRESH_EXPIRY=604800
COOKIE_SECURE=true

# routing
APP_URL=https://traein.semyon.ie
CORS_ORIGINS=https://traein.semyon.ie
API_RATE_LIMIT_FREE_TIER_LIMIT=1000
API_RATE_LIMIT_COFFEE_TIER_LIMIT=10000
API_RATE_LIMIT_UNLIMITED_ROLES=pro,admin
API_RATE_LIMIT_IP_SALT=rail-salt

# billing (Polar.sh — primary, see auth-billing.md)
POLAR_ACCESS_TOKEN=polar_at_...
POLAR_WEBHOOK_SECRET=polar_wh_...
POLAR_ORGANIZATION_ID=...
POLAR_COFFEE_PRODUCT_ID=...
POLAR_PRO_PRODUCT_ID=...
POLAR_ENVIRONMENT=production

# billing (Stripe — legacy, optional until removed)
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_COFFEE_PRICE_ID=
STRIPE_PRO_PRICE_ID=

# edge
CLOUDFLARE_TUNNEL_TOKEN=...
```

Full description of each variable is in [auth-billing.md](auth-billing.md#polar-config-env) and [api.md](api.md#environment).

## First-time setup

```bash
git clone <repo>
cd irish-rail-nabber
cp .env.local.example .env.local       # if present; otherwise use the template above
docker compose pull
docker compose up -d
sleep 30
docker compose logs --tail=50
```

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

The full disaster-recovery plan, including verification queries and emergency procedures, is at `private/RECOVERY_PLAN.md` (gitignored). Summary here.

### Backup schedule

- **Hourly**: `pg_dump | gzip` to `backups/hourly/`, keep last 6.
- **Daily 02:00**: `pg_dump | gzip` to `backups/daily/`, keep indefinitely.
- Driven by cron on the host, script `backup-db.sh`.

### Targets

| Metric | Target | Current |
|--------|--------|---------|
| RPO (max data loss) | < 1 h | < 1 h (hourly) |
| RTO (recovery time) | < 15 min | ~5–10 min |

### Restore (most common)

```bash
ssh semyon@server
docker stop irish_rail_daemon

BACKUP=$(ls -t backups/hourly/*.sql.gz | head -1)
gunzip -c "$BACKUP" > /tmp/restore.sql

docker exec -i irish_rail_db psql -U irish_data -d postgres \
  -c "DROP DATABASE IF EXISTS ireland_public; CREATE DATABASE ireland_public;"
docker exec -i irish_rail_db psql -U irish_data -d ireland_public < /tmp/restore.sql
docker start irish_rail_daemon
```

Then run the verification queries from [testing.md](testing.md).

### Monthly test

```bash
./recover.sh test    # restores latest backup to ireland_public_test, leaves prod untouched
```

This must pass once a month. If it has not run in 30 days, the next restore is unverified.

## Logs

- `docker compose logs <service> --tail=200` for each container.
- Daemon uses JSON log driver, 10MB × 3 files retained.
- API logs through `tracing` to stdout (`RUST_LOG=irish_rail_api=info`).

## Migrations

Migrations are SQL files under `migrations/`, applied in numeric order. Apply on demand:

```bash
docker exec -i irish_rail_db psql -U irish_data -d ireland_public \
  < migrations/<NNN>_<name>.sql
```

`schema.sql` (in the daemon image) idempotently creates the initial set on first boot. Anything past the initial schema is a numbered migration.

## Related docs

- [architecture.md](architecture.md) — service topology
- [scraper.md](scraper.md) — known networking issues, daemon behaviour
- [api.md](api.md) — Rust service env
- [auth-billing.md](auth-billing.md) — Polar/Stripe env
- [testing.md](testing.md) — post-deploy verification
- [../ROADMAP.md](../ROADMAP.md) — when to scale up
