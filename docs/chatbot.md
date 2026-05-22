# Chatbot

The chat route is now a real model-backed assistant:

- Frontend: `dashboard/src/pages/ChatAssistant.tsx`
- Backend: `api/src/chat.rs`
- Endpoint: `POST /chat`

## Current status

Done.

- OpenAI function-calling assistant is wired end-to-end.
- Model responses are produced from tool results only (no fabricated schedules).
- Role-gated access: only `coffee`, `pro`, and `admin` users can use chat.
- The dashboard route `/chat` is fully hooked to backend.
- Dev and production proxy paths now forward `/chat` to the API.

## Toolset used by the model

Each tool maps to a GraphQL query with bounded inputs and output limits:

| Tool | GraphQL query |
| --- | --- |
| `stations` | `stations` |
| `station_board` | `stationBoard` |
| `train_journey` | `trainJourney` |
| `route_reliability` | `routeReliability` |
| `station_delay_stats` | `stationDelayStats` |
| `hourly_delays` | `hourlyDelays` |
| `network_summary` | `networkSummary` |
| `fetch_status` | `fetchStatus` |
| `live_trains` | `liveTrains` |

## Request/response contract

`POST /chat`

Payload:

```json
{
  "message": "How late is the next 10:10 from Heuston?"
}
```

Response:

```json
{
  "answer": "The train is expected to be 3 minutes late.",
  "tools": [
    {
      "name": "station_board",
      "arguments": {"stationCode":"HST","limit":20},
      "rows": 20,
      "truncated": false,
      "result": "[{...}]"
    }
  ],
  "model": "gpt-4o-mini"
}
```

## Infra and limits

Environment knobs:

- `OPENAI_API_KEY` (required, fallback: `LLM_API_KEY`)
- `OPENAI_BASE_URL` (default `https://api.openai.com`, fallback: `LLM_API_URL`)
- `CHAT_MODEL` (default `gpt-4o-mini`, fallback: `LLM_MODEL`)
- `CHAT_MAX_TOKENS` (default `1200`)
- `CHAT_MAX_TOOL_ITERATIONS` (default `3`)
- `CHAT_MAX_TOOL_CALLS_PER_TURN` (default `3`)
- `CHAT_REQUEST_TIMEOUT_SECONDS` (default `45`)
- `CHAT_TOOL_RESULT_MAX_CHARS` (default `3500`)
- `CHAT_STATION_BOARD_LIMIT` (default `120`)
- `CHAT_STATION_DELAY_LIMIT` (default `40`)
- `CHAT_STATION_DELAY_HOURS` (default `168`)
- `CHAT_HOURLY_HOURS` (default `168`)
- `CHAT_STATION_HOURLY_HOURS` (default `72`)
- `CHAT_ROUTE_HOURS` (default `720`)
- `CHAT_ROUTE_MIN_TRAINS` (default `3`)
- `CHAT_LIVE_TRAINS_LIMIT` (default `200`)

## Notes

- Tool calls are capped per request and logged back in response.
- `POST /chat` shares the existing `graphql_rate_limit` middleware in `api/src/main.rs`.
- Session persistence and streaming responses are not yet implemented; this is a single-turn JSON request/response for now.
