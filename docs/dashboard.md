# Dashboard

React 19 SPA. Built and served with [Vite+](https://vitejs.dev/) under `dashboard/`. nginx in front for prod, Cloudflare Tunnel terminates TLS.

## Routes

```
/                  LiveMap         public
/stations          Stations        public
/login             LoginPage       public
/register          RegisterPage    public
/pricing           PricingPage     public
/account           AccountPage     protected (any signed-in user)
/analytics         Analytics       protected + paid (coffee/pro)
/chat              Chatbot         protected + paid  (see chatbot.md)
```

`ProtectedRoute` redirects to `/login` if `useAuth()` reports no user; paid pages additionally check `user.role !== 'free'`.

## Layout

```
dashboard/src/
├── App.tsx                  Router root, AuthProvider, URQL Provider
├── main.tsx                 mount
├── auth/
│   ├── AuthProvider.tsx     fetches /auth/me on mount, holds user
│   ├── useAuth.ts           login / register / logout / refresh
│   ├── LoginPage.tsx
│   ├── RegisterPage.tsx
│   └── ProtectedRoute.tsx
├── billing/
│   ├── PricingPage.tsx      plan cards, calls /billing/checkout
│   └── AccountPage.tsx      current plan, link to portal
├── pages/
│   ├── LiveMap.tsx          map + recentTrains subscription
│   ├── Stations.tsx         station list + per-station board
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
  fetchOptions: { credentials: "include" }, // send auth cookie
});
```

REST calls (auth, billing) use the typed wrapper in `graphql/api.ts`:

```ts
api.login(email, password)
api.register(email, password, displayName)
api.logout()
api.me()
api.checkout(priceId)
api.portal()
```

All requests include credentials so the httpOnly cookie is sent automatically.

## Auth flow

On boot, `AuthProvider` calls `GET /auth/me`. If the cookie is valid, the user is in context. If `/auth/me` returns 401, the provider calls `POST /auth/refresh` and retries once. Failed refresh = anonymous.

On any 401 from a GraphQL or REST call after boot, the same single-flight refresh runs. See [auth-billing.md](auth-billing.md#token-rotation) for token lifetimes.

## Dev workflow

The dashboard uses [Vite+](https://vitejs.dev/), wrapping pnpm, Vite, Vitest, and Oxlint behind one CLI. **Do not use pnpm directly** — let `vp` manage everything.

```bash
cd dashboard
vp install           # install deps
vp dev               # local dev server (proxies /graphql, /auth, /billing to localhost:8000)
vp check             # format + lint + types
vp test              # unit tests
vp build             # production bundle
```

The full Vite+ cheat sheet is checked in at `dashboard/AGENTS.md`.

### Vite dev proxy

`dashboard/vite.config.ts` proxies the API paths so cookies stay first-party:

```ts
server: {
  proxy: {
    "/graphql": "http://localhost:8000",
    "/auth":    "http://localhost:8000",
    "/billing": "http://localhost:8000",
  },
},
```

## Production

The dashboard ships as a static bundle served by nginx (`dashboard/Dockerfile` builds with `vp build`, copies `dist/` into `nginx:alpine`). nginx proxies `/graphql`, `/auth`, `/billing` to the `api` service on the docker network and serves the SPA for everything else. The container sits behind Cloudflare Tunnel — see [deployment.md](deployment.md).

## Related docs

- [api.md](api.md) — the endpoints the dashboard calls
- [auth-billing.md](auth-billing.md) — cookies, refresh, pricing pages
- [chatbot.md](chatbot.md) — the `/chat` route's design
- [deployment.md](deployment.md) — Docker, nginx config, tunnel
