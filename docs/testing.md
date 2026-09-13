# Testing

Verification recipes for the stack. Run these after first deploy, after a restore from backup ([deployment.md](deployment.md#backups-and-recovery)), and after any schema change.

## Sixty-second smoke test

```bash
cd /home/semyon/server-stacks/irish-rail
docker compose --env-file stack.env -f stack.yaml ps --all
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
SELECT 'bus stop updates (last 10 min)',     COUNT(*) FROM bus_stop_updates
       WHERE fetched_at > NOW() - INTERVAL '10 minutes'
UNION ALL
SELECT 'current bus vehicles',               COUNT(*) FROM bus_vehicle_positions
       WHERE last_seen_at > NOW() - INTERVAL '5 minutes'
UNION ALL
SELECT 'fetch successes (last 10 min)',      COUNT(*) FROM fetch_history
       WHERE status = 'success' AND fetched_at > NOW() - INTERVAL '10 minutes'
UNION ALL
SELECT 'fetch errors (last 10 min)',         COUNT(*) FROM fetch_history
       WHERE status = 'failed' AND fetched_at > NOW() - INTERVAL '10 minutes';
```

Expected after several minutes of steady-state collection:

| metric | expected |
|--------|----------|
| stations | 171 |
| train snapshots (last min) | 5–20 (only when positions change) |
| station events (last min) | 200–600 |
| bus stop updates (last 10 min) | non-zero when bus predictions changed in the window |
| current bus vehicles | non-zero after a successful `nta_vehicles` poll |
| fetch successes (last 10 min) | 100+ |
| fetch errors (last 10 min) | 0 |

A persistent non-zero fetch error count is the canary for the docker bridge / VPN issue.

Confirm that the two NTA operations share the same rate limit:

```sql
SELECT endpoint, status, fetched_at, record_count
FROM fetch_history
WHERE endpoint IN ('nta_trip_updates', 'nta_vehicles')
ORDER BY fetched_at DESC
LIMIT 10;
```

Both endpoints should appear in alternation. Consecutive requests across the two endpoints must stay at least 60 seconds apart.

## API health

```bash
docker exec irish_rail_api curl -fsS http://127.0.0.1:8000/health  # → "ok"
curl -fsS https://traein.semyon.ie/auth/config

# Anonymous GraphQL through the public proxy
curl -s -H "Content-Type: application/json" -d '{"query":"{ liveTrains { trainCode } }"}' \
  https://traein.semyon.ie/graphql | head
```

## Auth round-trip

```bash
curl -fsS https://traein.semyon.ie/auth/config
# → { "clerk_publishable_key": "pk_...", "billing_enabled": false }
```

Complete sign-up, email verification and sign-out in the dashboard. A signed-in `GET /auth/session` must return the local user with role `free`. Clerk owns credentials and session rotation; provider details are in [auth-billing.md](auth-billing.md).

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

## Stateless restart check

```bash
docker restart irish_rail_daemon irish_rail_api irish_rail_dashboard
docker exec irish_rail_db psql -U irish_data -d ireland_public \
  -c "SELECT COUNT(*) FROM train_snapshots;"
```

Row count must not drop after restarting the stateless services. Do not recreate the current PG18 production container until its anonymous data volume has been migrated to the corrected named-volume mount.

## Troubleshooting

| Symptom | Most likely cause | Where to look |
|---------|-------------------|---------------|
| `docker compose` not found | newer CLI uses `docker compose` (space) | use the new form |
| Daemon never inserts | bridge networking blocked | [scraper.md](scraper.md#nftables-blocks-docker-bridge) |
| 100% fetch errors | upstream unreachable | `curl http://api.irishrail.ie/realtime/realtime.asmx/getAllStationsXML` |
| Signed-in account never loads | missing or mismatched Clerk keys | [auth-billing.md](auth-billing.md) |
| API returns 403 on `/billing/webhook` | wrong webhook secret | check `POLAR_WEBHOOK_SECRET` and the raw-body proxy path |
| Signed-in requests are anonymous | missing Clerk bearer token or wrong authorized party | [auth-billing.md](auth-billing.md#clerk-sessions) |
| Station boards collecting zero rows | `getAllStationsXML` failed at boot | restart daemon; see [scraper.md](scraper.md#station-board-startup-race) |

## Success criteria

Every check above passes, and:

- The six long-running application/data containers plus the tunnel are healthy and the one-shot `migrate` container exited successfully in `docker compose ps --all`.
- 171 stations in the database.
- Zero fetch errors in the last 10 minutes.
- Clerk sign-up / login / `/auth/session` / `/auth/me` round-trips green.
- 24-hour run shows consistent collection.
- Data is unchanged by a stateless-service restart.

When all of these hold, the system is production-ready.

## Related docs

- [scraper.md](scraper.md) — what to expect from the daemon
- [buses.md](buses.md) — bus feed setup, schema and checks
- [api.md](api.md) — endpoint reference
- [deployment.md](deployment.md) — restore procedure
- [auth-billing.md](auth-billing.md) — auth setup
