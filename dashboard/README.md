# Irish Rail Dashboard

React 19 + TypeScript dashboard for the Irish Public Data API. The dashboard is the browser UI for exploring the Irish Rail collector data exposed by the repo's API layer.

## What lives here

- `src/` contains the Vite+ React application.
- `package.json` uses `pnpm` through the Vite+ (`vp`) workflow.
- `eslint.config.js`, `tsconfig*.json`, and `vite.config.ts` contain the frontend build/check configuration.

For the collector, database, API, and analysis context, start with the [root README](../README.md) and `docs/analysis/`.

## Local development

From this `dashboard/` directory:

```bash
vp install
vp dev
```

Use the development server printed by `vp dev`. The dashboard expects the local API stack from the repository root when features need live GraphQL/data responses:

```bash
cd ..
docker-compose up -d
```

## Verification

Run the frontend check before opening a PR:

```bash
vp check
```

If you only changed documentation, also run a whitespace check from the repo root:

```bash
git diff --check
```

## Build and preview

```bash
vp build
vp preview
```

`vp build` produces the production frontend bundle; `vp preview` serves that built output locally for a smoke test.
