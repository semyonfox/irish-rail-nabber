# Anonymous dashboard reporting

Collection is off by default. To prepare an explicitly approved deployment, set both `VITE_TELEMETRY_ENABLED=true` and `VITE_TELEMETRY_ENDPOINT` to the owner's HTTPS ingestion endpoint or a relative same-origin proxy path. No endpoint is included here. These are build-time settings. The app does not deploy or start a collector.

Help describes collection and provides a disable switch. Global Privacy Control, Do Not Track and unreadable preferences suppress events. The switch stores only a boolean preference under `traein-telemetry-disabled`. Existing authentication and request-limit accounting remain separate.

The client sends only `version`, `app`, `kind`, `name`, `surface` and `route`. App is `irish-rail-nabber`, surface is `web`, and route is a fixed category selected in source. Screen counts and the recoverable `request_failed` category contain no URLs, query strings, station/stop/train IDs, search text, account data, timestamps, messages or stacks. There are no visitor IDs, recordings, cookies, persistent event queues or retries.

Transport omits credentials and referrers, rejects redirects, times out after two seconds and allows one request in flight. Events are capped at 20 per minute and 200 per page lifetime. Repeated errors for a route are suppressed for 60 seconds. Telemetry failure cannot block the application.

The shared self-hosted collector contract aggregates counts by UTC day. Count retention is 30 days, error retention is 14 days, and purge runs hourly. It stores no raw events, request metadata or exact client timestamps. A separately approved proxy must strip identifying transport headers and disable access/request logs on ingestion. Collector deployment, retention enforcement and end-to-end ingestion have not been performed by this dashboard change.

Run `vp test src/utils/telemetry.test.ts` in `dashboard/` to check default suppression, opt-out, exact payloads, private fixtures, transport failures and bounds.
