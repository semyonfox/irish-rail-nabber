# Chatbot

Natural-language interface to the Irish Rail dataset. The chatbot answers questions like "is the 17:30 from Heuston running late?" or "which stations had the worst delays last week?" by calling the GraphQL API through a fixed set of tools.

> Status: design. No code yet.

## Goals

- One product surface (`/chat`) that subsumes most paid-tier value: analytics, historical lookups, predictions.
- The model never invents data. Every factual answer is sourced from a tool call against the database.
- Tools are derived from the existing GraphQL schema, not a parallel API.
- Strict tier gating at the entrypoint so individual tools don't need to re-check auth.

## Why this exists

The free dashboard handles "where is train X right now" through the live map. Past that, users want comparisons, history, and forecasts — which require composing several GraphQL queries, joining results, and explaining what they mean. That is what an LLM with tool access does well, and it justifies the paid tier far more cleanly than locking individual GraphQL fields.

See [auth-billing.md](auth-billing.md#tiers) for tier definitions.

## Architecture

```
dashboard /chat  ──► chatbot service  ──► Anthropic Messages API (Claude Sonnet 4.6 by default)
                          │  ▲
                          │  │ tool_use / tool_result
                          ▼  │
                       Tool layer
                          │
                          ▼
                  api /graphql + sqlx queries
                          │
                          ▼
                     TimescaleDB
```

The chatbot is its own service so it can be rate-limited and budgeted independently from the public API. It authenticates to the Rust API as a service account and forwards the end-user's role via a signed JWT claim so per-user quotas can still be enforced upstream if needed.

Default model: `claude-sonnet-4-6`. Heavier reasoning (e.g. plan a multi-step analysis, write a SQL summary) uses `claude-opus-4-7`. Cheap admin / classification calls use `claude-haiku-4-5`. Prompt caching is always on. See the `claude-api` skill for cache + thinking + tool-use patterns.

## Tool surface

Tools are thin GraphQL wrappers. Each maps to one query, with no hidden side effects.

| Tool | Backing query | Notes |
|------|---------------|-------|
| `find_stations` | `stationsByName` | fuzzy + code search |
| `station_board` | `stationBoard` | next-90-min arrivals/departures |
| `train_position` | `trainSnapshot` | latest known position |
| `train_journey` | `trainMovements` | full stop sequence |
| `recent_trains` | `recentTrains` | trains active in last N minutes |
| `delay_history` | `delayHistory` | bucketed delays per station/corridor |
| `network_path` | derived from `network_graph.md` | shortest physical path between two stations |
| `service_summary` | `serviceSummary` | on-time %, p50/p95 delay, observed runtimes |

Tool schemas mirror the GraphQL arguments. The model sees JSONSchema-typed tools; the service translates each `tool_use` into a GraphQL query at the API and returns the result as `tool_result`.

### Tool design rules

1. Read-only. The chatbot never writes to the database.
2. Bounded result size. Every tool has a hard cap (e.g. 200 rows) to keep tool_result payloads small and the cache hot.
3. Deterministic. Same args → same query → same shape, so the cache prefix stays stable.
4. No free-text SQL. The model cannot execute arbitrary SQL; if a question needs a new shape, that becomes a new tool.

## Conversation model

- One conversation per browser session, kept in `chat_sessions` (Postgres, separate from the time-series tables).
- Messages stored as `(role, content, tool_calls, tool_results, model, tokens_in, tokens_out, created_at)`.
- The system prompt names the dataset, the timezone (Europe/Dublin), the tool list, and instructs the model to cite sources by tool call.
- Prompt caching marks the system prompt + tool definitions + last completed turn as cacheable, so multi-turn conversations stay cheap.

## Rate limiting and cost control

Limits run on three layers:

1. **Tier gate** at the chatbot entrypoint. Anonymous and `free` are rejected with a redirect to `/pricing`.
2. **Per-user token budget** per rolling 24h. Coffee tier gets a modest budget; Pro is effectively unlimited subject to abuse rules. Stored in `chat_usage`.
3. **Per-request hard caps**: `max_tokens`, max tool calls, max total iterations.

Cost telemetry is recorded per-message so it can be compared against revenue from [auth-billing.md](auth-billing.md).

## Safety

- The system prompt forbids unverifiable claims about future train operations beyond the published schedule.
- For delay predictions the model must call `delay_history` and `service_summary` and disclose the data window.
- All tool calls are logged with the resolved GraphQL operation for audit.
- No PII collection beyond what the user types — chat history is theirs to delete from the account page.

## Storage

```sql
chat_sessions (
    id           UUID PRIMARY KEY,
    user_id      UUID REFERENCES users(id) ON DELETE CASCADE,
    title        TEXT,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    updated_at   TIMESTAMPTZ DEFAULT NOW()
);

chat_messages (
    id           UUID PRIMARY KEY,
    session_id   UUID REFERENCES chat_sessions(id) ON DELETE CASCADE,
    role         TEXT,            -- user, assistant, tool
    content      JSONB,           -- text, tool_use, tool_result blocks
    model        TEXT,
    tokens_in    INT,
    tokens_out   INT,
    cached       BOOLEAN,
    created_at   TIMESTAMPTZ DEFAULT NOW()
);

chat_usage (
    user_id      UUID REFERENCES users(id) ON DELETE CASCADE,
    day          DATE,
    tokens_in    INT,
    tokens_out   INT,
    PRIMARY KEY (user_id, day)
);
```

## Endpoints (proposed)

| Path | Method | Auth | Purpose |
|------|--------|------|---------|
| `/chat/sessions` | GET | paid | list sessions |
| `/chat/sessions` | POST | paid | create session |
| `/chat/sessions/:id` | DELETE | paid | delete session |
| `/chat/sessions/:id/messages` | GET | paid | load history |
| `/chat/sessions/:id/messages` | POST (SSE stream) | paid | send a turn, stream response |

Streams use server-sent events so the dashboard can render tool calls inline (`searching delay_history for GLWY…`).

## Open questions

- Pick implementation language. The Rust API already has the GraphQL client and DB pool; embedding the chatbot there keeps deployment simple. A separate TypeScript service makes Anthropic SDK + streaming easier. Default: TypeScript service deployed as a sibling container.
- Decide whether tool definitions are generated from the GraphQL schema (single source of truth) or hand-written (full control over arg shapes and result trimming). Default: hand-written for now, automate later.
- Long-term: optional `claude-opus-4-7` toggle for power users at higher cost-per-message.

## Related docs

- [api.md](api.md) — the GraphQL surface the tools wrap
- [auth-billing.md](auth-billing.md) — tier gating
- [scraper.md](scraper.md#schema) — the underlying data shapes
- [analysis/overview.md](analysis/overview.md) — what kinds of answers the corpus can support
