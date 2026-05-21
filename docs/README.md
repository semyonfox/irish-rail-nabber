# Docs

Single source of truth for irish-rail-nabber. Each doc owns one concern; cross-references link the rest.

## Read order for a new contributor

1. [architecture.md](architecture.md) — what the system is and how the pieces fit
2. [scraper.md](scraper.md) — the Python daemon that collects data
3. [api.md](api.md) — the Rust GraphQL + REST API
4. [dashboard.md](dashboard.md) — the React UI
5. [chatbot.md](chatbot.md) — the AI assistant with database tools
6. [auth-billing.md](auth-billing.md) — accounts, Polar.sh, paid tiers
7. [data-sources.md](data-sources.md) — the upstream Irish Rail API
8. [deployment.md](deployment.md) — Docker, cloud, backups, recovery
9. [network-graph.md](network-graph.md) — rail topology and visualizations
10. [testing.md](testing.md) — verification checklists

## Analysis

Conclusions drawn from the collected data live separately:

- [analysis/overview.md](analysis/overview.md) — main summary
- [analysis/bottleneck.md](analysis/bottleneck.md) — Galway–Athenry single-track corridor
- [analysis/operations.md](analysis/operations.md) — alerting and follow-up plan

## Internal specs and plans

Historical design specs and the step-by-step implementation plans that produced the current code live under [superpowers/](superpowers/). They are point-in-time artifacts; if a spec disagrees with the current code, the code wins.

## Top-level pointers

- [../README.md](../README.md) — project pitch and quick-start
- [../ROADMAP.md](../ROADMAP.md) — phases and revenue plan
