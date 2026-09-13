# Dashboard

React 19 SPA. Built and served with [Vite+](https://viteplus.dev/) under `dashboard/`. nginx in front for prod, Cloudflare Tunnel terminates TLS.

## Routes

```
/                  LiveMap         public
/stations          Stations        public
/buses             Buses           public
/login             LoginPage       public
/register          RegisterPage    public
/pricing           PricingPage     public
/history           History         protected (coffee/pro)
/account           AccountPage     protected (any signed-in user)
/analytics         Analytics       protected + paid (coffee/pro)
/chat              Chat Assistant   protected + paid (uses live tools)
```

`ProtectedRoute` redirects signed-out visitors to `/login`. Routes marked `requirePaid` accept only `coffee`, `pro`, and `admin` roles and send other signed-in users to `/pricing`. The API repeats the entitlement check on every paid resolver and chat request.

## Layout

```
dashboard/src/
├── App.tsx                  Router root, AuthProvider, URQL Provider
├── main.tsx                 mount
├── auth/
│   ├── AuthProvider.tsx     maps Clerk session to /auth/session account state
│   ├── useAuth.ts           Clerk session + local account state
│   ├── LoginPage.tsx
│   ├── RegisterPage.tsx
│   └── ProtectedRoute.tsx
├── billing/
│   ├── PricingPage.tsx      plan cards, calls /billing/checkout
│   └── AccountPage.tsx      current plan, link to portal
├── pages/
│   ├── LiveMap.tsx          map + polled liveTrains query
│   ├── Stations.tsx         station list + per-station board
│   ├── Buses.tsx            stop finder, live board + route delays
│   └── Analytics.tsx        paid: delay history, percentiles
├── components/              shared UI primitives
├── graphql/
│   ├── client.ts            URQL client (credentials: 'include')
│   ├── queries.ts           graphql-tag documents
│   └── api.ts               typed fetch wrapper for /auth and /billing
├── utils/
└── index.css                Tailwind base
```

## Data layer

GraphQL queries go through URQL. The client is created once:

```ts
import { Client, cacheExchange, fetchExchange } from "urql";

export const client = new Client({
  url: import.meta.env.VITE_GRAPHQL_URL || "/graphql",
  exchanges: [cacheExchange, fetchExchange],
  fetchOptions: { credentials: "include" }, // Clerk cookie fallback
});
```

REST calls (auth, billing) use the typed wrapper in `graphql/api.ts`:

```ts
api.config()
api.session()
api.me()
api.checkout("coffee")
api.portal()
```

All requests attach the current Clerk bearer token. Credentials remain enabled for Clerk's first-party `__session` cookie fallback.

The public bus page searches the active static GTFS snapshot and polls one combined live operation each minute for the selected stop board, current vehicle positions, and route delay history over 6-, 24-, or 72-hour windows. Vehicle dots use the latest accepted NTA GTFS-Realtime VehiclePositions snapshot; when that feed has no current positions, the stop search and static schedule remain available.

## Auth flow

On boot, `AuthProvider` loads the public Clerk key from `GET /auth/config`. Once Clerk resolves the browser session, it calls `GET /auth/session` to load the local plan role. Account provisioning or network failures appear as retryable errors with a sign-out escape instead of silently logging the user out. A keyed identity boundary clears the local user and URQL cache when the active Clerk user changes. Protected routes carry their path through the Clerk flow so a successful login returns to the requested page.

Clerk rotates its own short-lived session token. Explicit account refreshes request a fresh bearer token before reloading the local role. See [auth-billing.md](auth-billing.md#clerk-sessions).

## Dev workflow

The dashboard uses [Vite+](https://viteplus.dev/), wrapping pnpm, Vite, Vitest, and Oxlint behind one CLI. **Do not use pnpm directly** — let `vp` manage everything.

```bash
cd dashboard
vp install           # install deps
vp dev               # local dev server (proxies API routes to localhost:8001)
vp check             # format + lint + types
vp test              # unit tests
vp build             # production bundle
```

The full Vite+ cheat sheet is checked in at `dashboard/AGENTS.md`.

### Vite dev proxy

`dashboard/vite.config.ts` proxies the API paths so local development remains same-origin:

```ts
server: {
  proxy: {
    "/graphql": "http://localhost:8001",
    "/auth":    "http://localhost:8001",
    "/billing": "http://localhost:8001",
  },
},
```

## Production

The dashboard ships as a static bundle served by nginx (`dashboard/Dockerfile` builds with `vp build`, copies `dist/` into `nginx:alpine`). nginx proxies `/graphql`, `/auth`, `/billing`, and browser-facing `/api/chat` to the `api` service on the docker network; `/api/chat` is rewritten to API `/chat`. It serves the SPA for everything else. The container sits behind Cloudflare Tunnel — see [deployment.md](deployment.md).

## Related docs

- [api.md](api.md) — the endpoints the dashboard calls
- [auth-billing.md](auth-billing.md) — Clerk sessions, Polar billing and pricing pages
- [chatbot.md](chatbot.md) — the `/chat` route's design
- [buses.md](buses.md) — bus data sources and backend contract
- [deployment.md](deployment.md) — Docker, nginx config, tunnel
