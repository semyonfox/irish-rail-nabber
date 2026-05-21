# irish-rail-nabber

Real-time Irish Rail data, exposed as a GraphQL API, a live dashboard, and an AI chatbot you can ask questions in plain English.

Live at [traein.semyon.ie](https://traein.semyon.ie).

## Quick start

```bash
git clone <repo>
cd irish-rail-nabber
cp docs/deployment.md /dev/null         # read it: env template lives there
docker compose up -d
sleep 30
docker compose logs --tail=50
```

Verify with the smoke test in [docs/testing.md](docs/testing.md).

## What's in the box

| Component | What it does | Doc |
|-----------|--------------|-----|
| **daemon** | Polls Irish Rail every 10–60s, dedups, writes to TimescaleDB | [docs/scraper.md](docs/scraper.md) |
| **api** | Rust GraphQL + REST (auth, billing) on Axum | [docs/api.md](docs/api.md) |
| **dashboard** | React 19 SPA: live map, station boards, account | [docs/dashboard.md](docs/dashboard.md) |
| **chatbot** | Natural-language queries via tool calls against the DB *(planned)* | [docs/chatbot.md](docs/chatbot.md) |
| **db** | PostgreSQL 18 + TimescaleDB, time-series hypertables | [docs/scraper.md#schema](docs/scraper.md#schema) |

System diagram and request flows: [docs/architecture.md](docs/architecture.md).

## Paid tiers

| Tier | Price | What you get |
|------|-------|--------------|
| free | €0 | live map, station boards, anonymous GraphQL, 1 k req/day |
| coffee | €5/mo | + analytics, history, limited chatbot |
| pro | €25/mo | + unlimited chatbot, exports, priority support |

Billed through [Polar.sh](https://polar.sh) (merchant of record — handles VAT). Stripe is the legacy provider, still in code. Full details: [docs/auth-billing.md](docs/auth-billing.md).

## Documentation

Everything is under [docs/](docs/). Start at [docs/README.md](docs/README.md).

Roadmap and revenue phasing: [ROADMAP.md](ROADMAP.md).

## License

MIT
