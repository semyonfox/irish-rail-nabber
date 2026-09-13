# Irish Rail Nabber

A multi-service rail-data platform built to explore asynchronous ingestion, time-series storage, Rust APIs and containerized delivery.

```text
Irish Rail realtime XML ─┐
                         ├──► Python ingestion daemons ───► PostgreSQL / TimescaleDB
NTA GTFS + GTFS-Realtime┘
                                      │
                                      ▼
                         Rust API (GraphQL + REST)
                                      │
                                      ▼
                           React dashboard
```

## Engineering highlights

- **Ingestion:** a Python daemon polls Irish Rail realtime endpoints, normalizes records, deduplicates updates with content hashes and writes time-series data.
- **Bus data:** a second Python daemon versions the NTA's matching GTFS schedule and stores changed stop predictions plus current bus locations. It alternates the two realtime operations within one shared request-per-minute budget.
- **Backend:** Rust, Axum, Tokio, SQLx and async-graphql provide GraphQL queries alongside REST endpoints for account, billing and chat integrations.
- **Data model:** PostgreSQL with TimescaleDB migrations models historical train positions, station data and time-series queries.
- **Dashboard:** a React 19/Vite client provides live-map, station, history, analytics and account workflows.
- **Operational shape:** Docker Compose gates the database schema through a one-shot migrator, then starts independent rail and bus daemons, the API, dashboard and tunnel.
- **Quality gates:** GitHub Actions is configured to check and test Rust, type-check/build the dashboard, and compile Python sources. A Jenkinsfile defines container-image build and deployment stages.

## Repository map

| Path | Purpose |
| --- | --- |
| `daemon.py` | asynchronous Irish Rail ingestion and normalization |
| `bus_daemon.py` | versioned NTA GTFS import, bus timings and vehicle tracking |
| `api/` | Rust/Axum GraphQL and REST service |
| `dashboard/` | React client |
| `migrations/` | PostgreSQL/TimescaleDB schema evolution |
| `docs/` | architecture, API, data-ingestion and operations notes |
| `docker-compose.yml` | local/container service topology |

## Development and scope

This is an actively developed portfolio system. Runtime availability, LLM configuration and billing integrations are environment-dependent; the repository should not be read as a public uptime or pricing commitment.

Clerk handles identity. Polar handles Coffee and Pro subscriptions as merchant of record, while the API keeps the resulting plan role locally for access checks.

## Documentation

Start at [docs/README.md](./docs/README.md). Useful entry points:

- [Architecture](./docs/architecture.md)
- [Data ingestion](./docs/scraper.md)
- [API](./docs/api.md)
- [Dashboard](./docs/dashboard.md)
- [Testing](./docs/testing.md)
- [Deployment](./docs/deployment.md)
