# Irish Rail Nabber

A multi-service rail-data platform built to explore asynchronous ingestion, time-series storage, Rust APIs and containerized delivery.

```text
Irish Rail realtime XML
        │
        ▼
Python ingestion daemon ───► PostgreSQL / TimescaleDB
                                      │
                                      ▼
                         Rust API (GraphQL + REST)
                                      │
                                      ▼
                           React dashboard
```

## Engineering highlights

- **Ingestion:** a Python daemon polls Irish Rail realtime endpoints, normalizes records, deduplicates updates with content hashes and writes time-series data.
- **Backend:** Rust, Axum, Tokio, SQLx and async-graphql provide GraphQL queries alongside REST endpoints for account, billing and chat integrations.
- **Data model:** PostgreSQL with TimescaleDB migrations models historical train positions, station data and time-series queries.
- **Dashboard:** a React 19/Vite client provides live-map, station, history, analytics and account workflows.
- **Operational shape:** Docker Compose defines the database, daemon, API, dashboard and tunnel services; the API exposes health checks.
- **Quality gates:** GitHub Actions is configured to check and test Rust, type-check/build the dashboard, and compile Python sources. A Jenkinsfile defines container-image build and deployment stages.

## Repository map

| Path | Purpose |
| --- | --- |
| `daemon.py` | asynchronous Irish Rail ingestion and normalization |
| `api/` | Rust/Axum GraphQL and REST service |
| `dashboard/` | React client |
| `migrations/` | PostgreSQL/TimescaleDB schema evolution |
| `docs/` | architecture, API, data-ingestion and operations notes |
| `docker-compose.yml` | local/container service topology |

## Development and scope

This is an actively developed portfolio system. Runtime availability, LLM configuration and billing integrations are environment-dependent; the repository should not be read as a public uptime or pricing commitment.

The current implementation contains Stripe integration code. Any alternative billing-provider documentation is planning material until its implementation and configuration land together.

## Documentation

Start at [docs/README.md](./docs/README.md). Useful entry points:

- [Architecture](./docs/architecture.md)
- [Data ingestion](./docs/scraper.md)
- [API](./docs/api.md)
- [Dashboard](./docs/dashboard.md)
- [Testing](./docs/testing.md)
- [Deployment](./docs/deployment.md)
