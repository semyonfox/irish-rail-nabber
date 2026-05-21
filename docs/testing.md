# Testing

Verification recipes for the stack. Run these after first deploy, after a restore from backup ([deployment.md](deployment.md#backups-and-recovery)), and after any schema change.

## Sixty-second smoke test

```bash
docker compose up -d
sleep 30
docker compose ps                      # all services healthy?
docker exec irish_rail_db psql -U irish_data -d ireland_public \
  -c "SELECT COUNT(*) FROM stations;"  # expect 171
```

If `stations` is 0 the daemon failed its startup `getAllStationsXML` fetch. Most common cause: nftables blocking the docker bridge — see [scraper.md](scraper.md#nftables-blocks-docker-bridge).

## Data collection check

```sql
SELECT 'stations'                            AS metric, COUNT(*) AS count FROM stations
UNION ALL
SELECT 'train snapshots (last min)',         COUNT(*) FROM train_snapshots
       WHERE fetched_at > NOW() - INTERVAL '1 minute'
UNION ALL
SELECT 'station events (last min)',          COUNT(*) FROM station_events
       WHERE fetched_at > NOW() - INTERVAL '1 minute'
UNION ALL
SELECT 'fetch successes (last 10 min)',      COUNT(*) FROM fetch_history
       WHERE status = 'success' AND fetched_at > NOW() - INTERVAL '10 minutes'
UNION ALL
SELECT 'fetch errors (last 10 min)',         COUNT(*) FROM fetch_history
       WHERE status = 'failed' AND fetched_at > NOW() - INTERVAL '10 minutes';
```

Expected after a minute of steady-state collection:

| metric | expected |
|--------|----------|
| stations | 171 |
| train snapshots (last min) | 5–20 (only when positions change) |
| station events (last min) | 200–600 |
| fetch successes (last 10 min) | 100+ |
| fetch errors (last 10 min) | 0 |

A persistent non-zero fetch error count is the canary for the docker bridge / VPN issue.

## API health

```bash
curl -fsS http://localhost:8000/health     # → "ok"
curl -fsS https://traein.semyon.ie/health  # prod

# GraphQL playground (anonymous)
curl -s -H "Content-Type: application/json" -d '{"query":"{ recentTrains(hours:1){ trainCode } }"}' \
  http://localhost:8000/graphql | head
```

## Auth round-trip

```bash
curl -X POST http://localhost:8000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"SecurePass123"}' \
  -c cookies.txt

curl -s -b cookies.txt http://localhost:8000/auth/me
# → { "id": "...", "email": "test@example.com", "role": "free", ... }

curl -X POST -b cookies.txt http://localhost:8000/auth/logout
```

Tokens, rotation, and provider details: [auth-billing.md](auth-billing.md).

## Twenty-four hour stability

```bash
for i in {1..24}; do
  sleep 3600
  echo "Hour $i:"
  docker exec irish_rail_db psql -U irish_data -d ireland_public \
    -c "SELECT COUNT(*) FROM train_snapshots
        WHERE fetched_at > NOW() - INTERVAL '1 hour';"
done
```

Expected per hour:

- 1 000+ new `train_snapshots`
- 5 000–10 000 new `station_events`
- Zero daemon crashes (`docker compose ps` shows daemon up)

## Data persistence

```bash
docker compose stop
sleep 5
docker compose start
docker exec irish_rail_db psql -U irish_data -d ireland_public \
  -c "SELECT COUNT(*) FROM train_snapshots;"
```

Row count must not drop after a restart. If it does, the `postgres_data` volume is not mounted.

## Troubleshooting

| Symptom | Most likely cause | Where to look |
|---------|-------------------|---------------|
| `docker compose` not found | newer CLI uses `docker compose` (space) | use the new form |
| Daemon never inserts | bridge networking blocked | [scraper.md](scraper.md#nftables-blocks-docker-bridge) |
| 100% fetch errors | upstream unreachable | `curl http://api.irishrail.ie/realtime/realtime.asmx/getAllStationsXML` |
| API returns 500 on `/auth/*` | missing `JWT_SECRET` | [auth-billing.md](auth-billing.md) |
| API returns 403 on `/billing/webhook` | wrong webhook secret | check `POLAR_WEBHOOK_SECRET` / `STRIPE_WEBHOOK_SECRET` |
| Cookie not being sent from dashboard | URQL missing `credentials: 'include'` | [dashboard.md](dashboard.md#data-layer) |
| Station boards collecting zero rows | `getAllStationsXML` failed at boot | restart daemon; see [scraper.md](scraper.md#station-board-startup-race) |

## Success criteria

Every check above passes, and:

- All five containers healthy in `docker compose ps`.
- 171 stations in the database.
- Zero fetch errors in the last 10 minutes.
- Auth register / login / `/auth/me` round-trips green.
- 24-hour run shows consistent collection.
- Data survives a `compose stop && compose start`.

When all of these hold, the system is production-ready.

## Related docs

- [scraper.md](scraper.md) — what to expect from the daemon
- [api.md](api.md) — endpoint reference
- [deployment.md](deployment.md) — restore procedure
- [auth-billing.md](auth-billing.md) — auth setup
