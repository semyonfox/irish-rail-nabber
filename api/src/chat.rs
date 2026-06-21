use std::{env, time::Duration};

use async_graphql::{Request, Variables};
use axum::{extract::State, http::StatusCode, response::IntoResponse, Extension, Json};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{models::AuthUser, state::AppState};

const Q_STATIONS: &str = r#"
    query Stations($stationType: String, $isDart: Boolean) {
        stations(stationType: $stationType, isDart: $isDart) {
            stationCode
            stationDesc
            stationType
            isDart
            latitude
            longitude
        }
    }
"#;

const Q_STATION_BOARD: &str = r#"
    query StationBoard($stationCode: String!, $limit: Int) {
        stationBoard(stationCode: $stationCode, limit: $limit) {
            trainCode
            origin
            destination
            trainType
            direction
            status
            scheduledArrival
            scheduledDeparture
            expectedArrival
            expectedDeparture
            lateMinutes
            dueIn
            lastLocation
        }
    }
"#;

const Q_LIVE_TRAINS: &str = r#"
    query LiveTrains($trainType: String) {
        liveTrains(trainType: $trainType) {
            trainCode
            latitude
            longitude
            trainStatus
            direction
            fetchedAt
        }
    }
"#;

const Q_TRAIN_JOURNEY: &str = r#"
    query TrainJourney($trainCode: String!, $trainDate: String) {
        trainJourney(trainCode: $trainCode, trainDate: $trainDate) {
            trainCode
            trainDate
            locationCode
            locationFullName
            locationOrder
            trainOrigin
            trainDestination
            scheduledArrival
            scheduledDeparture
            expectedArrival
            expectedDeparture
            actualArrival
            actualDeparture
            stopType
        }
    }
"#;

const Q_ROUTE_RELIABILITY: &str = r#"
    query RouteReliability($hours: Int, $minTrains: Int) {
        routeReliability(hours: $hours, minTrains: $minTrains) {
            origin
            destination
            avgLateMinutes
            onTimePct
            trainCount
        }
    }
"#;

const Q_STATION_DELAY_STATS: &str = r#"
    query StationDelayStats($hours: Int, $limit: Int) {
        stationDelayStats(hours: $hours, limit: $limit) {
            stationCode
            stationDesc
            avgLateMinutes
            maxLateMinutes
            onTimePct
            totalEvents
        }
    }
"#;

const Q_HOURLY_DELAYS: &str = r#"
    query HourlyDelays($stationCode: String, $hours: Int) {
        hourlyDelays(stationCode: $stationCode, hours: $hours) {
            hour
            stationCode
            avgLateMinutes
            maxLateMinutes
            eventCount
        }
    }
"#;

const Q_NETWORK_SUMMARY: &str = r#"
    query NetworkSummary {
        networkSummary {
            activeTrains
            totalStations
            avgDelayMinutes
            onTimePct
            lastUpdated
        }
    }
"#;

const Q_FETCH_STATUS: &str = r#"
    query FetchStatus {
        fetchStatus {
            endpoint
            lastStatus
            lastRecordCount
            lastDurationMs
            lastFetched
        }
    }
"#;

const DEFAULT_TOOL_RESULT_CHARS: usize = 3500;

#[derive(Debug, Deserialize)]
pub(crate) struct ChatRequest {
    message: String,
}

#[derive(Debug, Serialize, Clone)]
struct ChatToolCallLog {
    name: String,
    arguments: Value,
    rows: usize,
    truncated: bool,
    result: String,
}

#[derive(Debug, Serialize)]
struct ChatResponse {
    answer: String,
    tools: Vec<ChatToolCallLog>,
    model: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct ErrorResponse {
    error: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct ModelMessage {
    role: String,
    content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_calls: Option<Vec<ModelToolCall>>,
    #[serde(rename = "tool_call_id", skip_serializing_if = "Option::is_none")]
    tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct ModelToolCall {
    id: String,
    #[serde(rename = "type")]
    kind: String,
    function: ModelToolFunction,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct ModelToolFunction {
    name: String,
    arguments: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct ModelChoice {
    message: ModelMessage,
}

#[derive(Debug, Serialize, Deserialize)]
struct ModelResponse {
    choices: Vec<ModelChoice>,
}

#[derive(Debug, Serialize)]
struct OpenAiRequest<'a> {
    model: &'a str,
    messages: &'a [ModelMessage],
    tools: &'a [Value],
    tool_choice: &'a str,
    temperature: f32,
    max_tokens: i64,
}

#[derive(Debug, Clone)]
struct ToolLimits {
    station_board_limit: i64,
    station_delay_stats_limit: i64,
    station_delay_stats_hours: i64,
    hourly_delay_hours: i64,
    station_hourly_hours: i64,
    route_hours: i64,
    route_min_trains: i64,
    live_trains_limit: i64,
}

#[derive(Debug, Clone)]
struct ChatConfig {
    api_key: String,
    model: String,
    base_url: String,
    max_tokens: i64,
    max_tool_iterations: usize,
    max_tool_calls_per_turn: usize,
    tool_result_max_chars: usize,
    request_timeout_secs: u64,
    limits: ToolLimits,
}

#[derive(Debug, Deserialize)]
struct StationsArgs {
    #[serde(rename = "stationType")]
    station_type: Option<String>,
    #[serde(rename = "isDart")]
    is_dart: Option<bool>,
    #[serde(default)]
    limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct StationBoardArgs {
    #[serde(rename = "stationCode")]
    station_code: String,
    limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct TrainJourneyArgs {
    #[serde(rename = "trainCode")]
    train_code: String,
    #[serde(rename = "trainDate")]
    train_date: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RouteReliabilityArgs {
    hours: Option<i64>,
    #[serde(rename = "minTrains")]
    min_trains: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct StationDelayStatsArgs {
    hours: Option<i64>,
    limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct HourlyDelaysArgs {
    #[serde(rename = "stationCode")]
    station_code: Option<String>,
    hours: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct LiveTrainsArgs {
    #[serde(rename = "trainType")]
    train_type: Option<String>,
    limit: Option<i64>,
}

fn json_error(status: StatusCode, message: &str) -> (StatusCode, Json<ErrorResponse>) {
    (
        status,
        Json(ErrorResponse {
            error: message.to_string(),
        }),
    )
}

fn parse_env_i64(name: &str, default: i64) -> i64 {
    env::var(name)
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(default)
}

fn parse_first_env_i64(names: &[&str], default: i64) -> i64 {
    names
        .iter()
        .find_map(|name| {
            env::var(name)
                .ok()
                .and_then(|value| value.parse::<i64>().ok())
                .filter(|value| *value > 0)
        })
        .unwrap_or(default)
}

fn parse_env_usize(name: &str, default: usize) -> usize {
    env::var(name)
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(default)
}

fn non_blank_env_value(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn first_env_var(names: &[&str]) -> Option<String> {
    names
        .iter()
        .find_map(|name| env::var(name).ok().and_then(non_blank_env_value))
}

fn request_timeout_secs() -> u64 {
    if let Some(timeout_ms) = env::var("LLM_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| *value > 0)
    {
        return ((timeout_ms + 999) / 1000) as u64;
    }

    parse_env_i64("CHAT_REQUEST_TIMEOUT_SECONDS", 45) as u64
}

fn chat_provider_unconfigured_error() -> (StatusCode, Json<ErrorResponse>) {
    json_error(
        StatusCode::SERVICE_UNAVAILABLE,
        "chat is temporarily unavailable because no LLM provider is configured",
    )
}

fn chat_config() -> Result<ChatConfig, (StatusCode, Json<ErrorResponse>)> {
    let api_key = first_env_var(&["LLM_API_KEY", "OPENAI_API_KEY"])
        .ok_or_else(chat_provider_unconfigured_error)?;

    let limits = ToolLimits {
        station_board_limit: parse_env_i64("CHAT_STATION_BOARD_LIMIT", 120),
        station_delay_stats_limit: parse_env_i64("CHAT_STATION_DELAY_LIMIT", 40),
        station_delay_stats_hours: parse_env_i64("CHAT_STATION_DELAY_HOURS", 168),
        hourly_delay_hours: parse_env_i64("CHAT_HOURLY_HOURS", 168),
        station_hourly_hours: parse_env_i64("CHAT_STATION_HOURLY_HOURS", 72),
        route_hours: parse_env_i64("CHAT_ROUTE_HOURS", 720),
        route_min_trains: parse_env_i64("CHAT_ROUTE_MIN_TRAINS", 3),
        live_trains_limit: parse_env_i64("CHAT_LIVE_TRAINS_LIMIT", 200),
    };

    let tool_result_max_chars = parse_env_i64(
        "CHAT_TOOL_RESULT_MAX_CHARS",
        DEFAULT_TOOL_RESULT_CHARS as i64,
    ) as usize;

    Ok(ChatConfig {
        api_key,
        model: first_env_var(&["LLM_MODEL", "CHAT_MODEL"])
            .unwrap_or_else(|| "gpt-4o-mini".to_string()),
        base_url: first_env_var(&["LLM_API_URL", "OPENAI_BASE_URL"])
            .unwrap_or_else(|| "https://api.openai.com".to_string()),
        max_tokens: parse_first_env_i64(&["LLM_MAX_TOKENS", "CHAT_MAX_TOKENS"], 1200),
        max_tool_iterations: parse_env_usize("CHAT_MAX_TOOL_ITERATIONS", 3),
        max_tool_calls_per_turn: parse_env_usize("CHAT_MAX_TOOL_CALLS_PER_TURN", 3),
        tool_result_max_chars,
        request_timeout_secs: request_timeout_secs(),
        limits,
    })
}

fn normalize_openai_base_url(base_url: &str) -> String {
    let trimmed = base_url.trim_end_matches('/').to_string();
    if trimmed.ends_with("/v1") {
        format!("{}/chat/completions", trimmed)
    } else {
        format!("{}/v1/chat/completions", trimmed)
    }
}

fn system_prompt() -> &'static str {
    "You are RailGPT, the Irish Rail data assistant. \
    You answer only from live/persistent train data and route history in the tools. \
    Never invent schedules, delays, or station status.\n\
    \n\
    Use tools for all factual answers. If user asks about arrivals/timetables, first identify a station code with stations and then call station_board. \
    If user asks about delays/trends/predictions, use route_reliability, station_delay_stats, and/or hourly_delays. \
    For trip history use train_journey. \
    If user asks about current service quality use network_summary.\n\
    Return concise plain language with short sentence answers."
}

fn tool_definitions() -> Vec<Value> {
    vec![
        json!({
            "type": "function",
            "function": {
                "name": "stations",
                "description": "List stations and metadata so you can resolve station names to codes.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "stationType": { "type": "string", "description": "Station type filter e.g. \"DART\", \"Intercity\"." },
                        "isDart": { "type": "boolean", "description": "Filter only Dart services." },
                        "limit": { "type": "integer", "minimum": 1, "maximum": 300, "description": "Optional response cap for display purposes." }
                    }
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "station_board",
                "description": "Get the latest arrivals/departures for one station. Best for timetable and \"how late\" at a platform level.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "stationCode": { "type": "string" },
                        "limit": { "type": "integer", "minimum": 5, "maximum": 120, "default": 20 }
                    },
                    "required": ["stationCode"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "train_journey",
                "description": "Fetch full stop sequence for one train.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "trainCode": { "type": "string" },
                        "trainDate": { "type": "string", "description": "Optional YYYY-MM-DD date." }
                    },
                    "required": ["trainCode"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "route_reliability",
                "description": "Route reliability and average lateness between origin and destination.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "hours": { "type": "integer", "minimum": 1, "maximum": 720, "default": 24 },
                        "minTrains": { "type": "integer", "minimum": 1, "maximum": 20, "default": 3 }
                    }
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "station_delay_stats",
                "description": "Station delay statistics and on-time rates over a period.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "hours": { "type": "integer", "minimum": 1, "maximum": 720, "default": 24 },
                        "limit": { "type": "integer", "minimum": 1, "maximum": 80, "default": 20 }
                    }
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "hourly_delays",
                "description": "Hour-by-hour delay trend for a station or all stations.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "stationCode": { "type": "string", "description": "Optional station filter." },
                        "hours": { "type": "integer", "minimum": 1, "maximum": 720, "default": 24 }
                    }
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "network_summary",
                "description": "Current network health summary with active trains and delay picture.",
                "parameters": { "type": "object", "properties": {} }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "fetch_status",
                "description": "Data ingestion status of upstream sources.",
                "parameters": { "type": "object", "properties": {} }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "live_trains",
                "description": "Current live train positions.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "trainType": { "type": "string", "description": "Optional filter for service type." },
                        "limit": { "type": "integer", "minimum": 10, "maximum": 300, "default": 50 }
                    }
                }
            }
        }),
    ]
}

fn is_paid_role(role: &str) -> bool {
    matches!(role, "coffee" | "pro" | "admin")
}

fn clamp(value: Option<i64>, min: i64, max: i64, default: i64) -> i64 {
    value.unwrap_or(default).clamp(min, max)
}

fn summarize_result(result: &Value, max_chars: usize) -> (String, bool) {
    let rendered = serde_json::to_string_pretty(result).unwrap_or_else(|_| "{}".to_string());
    let truncated = rendered.chars().count() > max_chars;
    if truncated {
        let short = rendered.chars().take(max_chars).collect::<String>();
        (format!("{short}…"), true)
    } else {
        (rendered, false)
    }
}

fn query_result_count(result: &Value, field: &str) -> usize {
    if let Some(array) = result.as_array() {
        return array.len();
    }

    result
        .get(field)
        .and_then(Value::as_array)
        .map(std::vec::Vec::len)
        .unwrap_or(0)
}

fn trim_array_payload(value: Value, limit: Option<usize>) -> Value {
    let Some(limit) = limit else {
        return value;
    };
    let Some(arr) = value.as_array() else {
        return value;
    };

    let max_rows = limit.min(arr.len());
    let trimmed = arr.iter().take(max_rows).cloned().collect::<Vec<_>>();
    Value::Array(trimmed)
}

fn parse_tool_arguments<T: for<'de> Deserialize<'de>>(
    name: &str,
    call: &ModelToolCall,
) -> Result<T, (StatusCode, Json<ErrorResponse>)> {
    serde_json::from_str::<T>(&call.function.arguments).map_err(|error| {
        json_error(
            StatusCode::BAD_REQUEST,
            &format!("invalid arguments for {name}: {error}"),
        )
    })
}

async fn execute_graphql_query(
    state: &AppState,
    auth_user: &AuthUser,
    query: &str,
    variables: Value,
) -> Result<Value, (StatusCode, Json<ErrorResponse>)> {
    let request = Request::new(query)
        .variables(Variables::from_json(variables))
        .data(Some(auth_user.clone()));

    let response = state.schema.execute(request).await;
    if !response.errors.is_empty() {
        let reasons = response
            .errors
            .iter()
            .map(|error| format!("{error:?}"))
            .collect::<Vec<_>>()
            .join("; ");
        return Err(json_error(
            StatusCode::BAD_GATEWAY,
            &format!("query failed: {reasons}"),
        ));
    }

    let response_json = serde_json::to_value(response).map_err(|error| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("failed to read graph response: {error}"),
        )
    })?;

    response_json.get("data").cloned().ok_or_else(|| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "missing graph response data",
        )
    })
}

async fn execute_tool(
    state: &AppState,
    auth_user: &AuthUser,
    call: &ModelToolCall,
    limits: &ToolLimits,
    tool_result_max_chars: usize,
) -> Result<ChatToolCallLog, (StatusCode, Json<ErrorResponse>)> {
    match call.function.name.as_str() {
        "stations" => {
            let args: StationsArgs = parse_tool_arguments("stations", call)?;
            let limit = args.limit.map(|value| clamp(Some(value), 1, 300, 300));
            let payload = execute_graphql_query(
                state,
                auth_user,
                Q_STATIONS,
                json!({
                    "stationType": args.station_type,
                    "isDart": args.is_dart
                }),
            )
            .await?;
            let key = "stations";
            let mut result = payload.get(key).cloned().unwrap_or(Value::Null);
            if let Some(limit) = limit {
                result = trim_array_payload(result, Some(limit as usize));
            }
            let rows = query_result_count(&result, key);
            let (summary, truncated) = summarize_result(&result, tool_result_max_chars);
            Ok(ChatToolCallLog {
                name: "stations".to_string(),
                arguments: json!({
                    "stationType": args.station_type,
                    "isDart": args.is_dart,
                    "limit": limit,
                }),
                rows,
                truncated,
                result: summary,
            })
        }
        "station_board" => {
            let args: StationBoardArgs = parse_tool_arguments("station_board", call)?;
            let limit = clamp(
                Some(args.limit.unwrap_or(20)),
                5,
                limits.station_board_limit,
                20,
            );
            let payload = execute_graphql_query(
                state,
                auth_user,
                Q_STATION_BOARD,
                json!({
                    "stationCode": args.station_code,
                    "limit": limit as i64
                }),
            )
            .await?;
            let key = "stationBoard";
            let result = payload.get(key).cloned().unwrap_or(Value::Null);
            let rows = query_result_count(&result, key);
            let (summary, truncated) = summarize_result(&result, tool_result_max_chars);
            Ok(ChatToolCallLog {
                name: "station_board".to_string(),
                arguments: json!({
                    "stationCode": args.station_code,
                    "limit": limit,
                }),
                rows,
                truncated,
                result: summary,
            })
        }
        "train_journey" => {
            let args: TrainJourneyArgs = parse_tool_arguments("train_journey", call)?;
            let payload = execute_graphql_query(
                state,
                auth_user,
                Q_TRAIN_JOURNEY,
                json!({
                    "trainCode": args.train_code,
                    "trainDate": args.train_date
                }),
            )
            .await?;
            let key = "trainJourney";
            let result = payload.get(key).cloned().unwrap_or(Value::Null);
            let rows = query_result_count(&result, key);
            let (summary, truncated) = summarize_result(&result, tool_result_max_chars);
            Ok(ChatToolCallLog {
                name: "train_journey".to_string(),
                arguments: json!({
                    "trainCode": args.train_code,
                    "trainDate": args.train_date,
                }),
                rows,
                truncated,
                result: summary,
            })
        }
        "route_reliability" => {
            let args: RouteReliabilityArgs = parse_tool_arguments("route_reliability", call)?;
            let hours = clamp(args.hours, 1, limits.route_hours, 24);
            let min_trains = clamp(args.min_trains, 1, 20, limits.route_min_trains);
            let payload = execute_graphql_query(
                state,
                auth_user,
                Q_ROUTE_RELIABILITY,
                json!({
                    "hours": hours,
                    "minTrains": min_trains,
                }),
            )
            .await?;
            let key = "routeReliability";
            let result = payload.get(key).cloned().unwrap_or(Value::Null);
            let rows = query_result_count(&result, key);
            let (summary, truncated) = summarize_result(&result, tool_result_max_chars);
            Ok(ChatToolCallLog {
                name: "route_reliability".to_string(),
                arguments: json!({
                    "hours": hours,
                    "minTrains": min_trains,
                }),
                rows,
                truncated,
                result: summary,
            })
        }
        "station_delay_stats" => {
            let args: StationDelayStatsArgs = parse_tool_arguments("station_delay_stats", call)?;
            let hours = clamp(args.hours, 1, limits.station_delay_stats_hours, 24);
            let limit = clamp(args.limit, 1, limits.station_delay_stats_limit, 20);
            let payload = execute_graphql_query(
                state,
                auth_user,
                Q_STATION_DELAY_STATS,
                json!({
                    "hours": hours,
                    "limit": limit,
                }),
            )
            .await?;
            let key = "stationDelayStats";
            let result = payload.get(key).cloned().unwrap_or(Value::Null);
            let rows = query_result_count(&result, key);
            let (summary, truncated) = summarize_result(&result, tool_result_max_chars);
            Ok(ChatToolCallLog {
                name: "station_delay_stats".to_string(),
                arguments: json!({
                    "hours": hours,
                    "limit": limit,
                }),
                rows,
                truncated,
                result: summary,
            })
        }
        "hourly_delays" => {
            let args: HourlyDelaysArgs = parse_tool_arguments("hourly_delays", call)?;
            let hours = clamp(args.hours, 1, limits.hourly_delay_hours, 24);
            let payload = execute_graphql_query(
                state,
                auth_user,
                Q_HOURLY_DELAYS,
                json!({
                    "stationCode": args.station_code,
                    "hours": hours
                }),
            )
            .await?;
            let key = "hourlyDelays";
            let result = payload.get(key).cloned().unwrap_or(Value::Null);
            let rows = query_result_count(&result, key);
            let (summary, truncated) = summarize_result(&result, tool_result_max_chars);
            Ok(ChatToolCallLog {
                name: "hourly_delays".to_string(),
                arguments: json!({
                    "stationCode": args.station_code,
                    "hours": hours,
                }),
                rows,
                truncated,
                result: summary,
            })
        }
        "network_summary" => {
            let payload =
                execute_graphql_query(state, auth_user, Q_NETWORK_SUMMARY, json!({})).await?;
            let key = "networkSummary";
            let result = payload.get(key).cloned().unwrap_or(Value::Null);
            let rows = if result.is_null() { 0 } else { 1 };
            let (summary, truncated) = summarize_result(&result, tool_result_max_chars);
            Ok(ChatToolCallLog {
                name: "network_summary".to_string(),
                arguments: json!({}),
                rows,
                truncated,
                result: summary,
            })
        }
        "fetch_status" => {
            let payload =
                execute_graphql_query(state, auth_user, Q_FETCH_STATUS, json!({})).await?;
            let key = "fetchStatus";
            let result = payload.get(key).cloned().unwrap_or(Value::Null);
            let rows = query_result_count(&result, key);
            let (summary, truncated) = summarize_result(&result, tool_result_max_chars);
            Ok(ChatToolCallLog {
                name: "fetch_status".to_string(),
                arguments: json!({}),
                rows,
                truncated,
                result: summary,
            })
        }
        "live_trains" => {
            let args: LiveTrainsArgs = parse_tool_arguments("live_trains", call)?;
            let limit = clamp(
                args.limit,
                10,
                limits.live_trains_limit,
                limits.live_trains_limit,
            );
            let payload = execute_graphql_query(
                state,
                auth_user,
                Q_LIVE_TRAINS,
                json!({
                    "trainType": args.train_type
                }),
            )
            .await?;
            let key = "liveTrains";
            let result = payload.get(key).cloned().unwrap_or(Value::Null);
            let rows = query_result_count(&result, key);
            let mut trimmed = result;
            if rows > limit as usize {
                trimmed = trim_array_payload(trimmed, Some(limit as usize));
            }
            let rows = query_result_count(&trimmed, key);
            let (summary, truncated) = summarize_result(&trimmed, tool_result_max_chars);
            Ok(ChatToolCallLog {
                name: "live_trains".to_string(),
                arguments: json!({
                    "trainType": args.train_type,
                    "limit": limit,
                }),
                rows,
                truncated,
                result: summary,
            })
        }
        name => Err(json_error(
            StatusCode::BAD_REQUEST,
            &format!("unsupported tool: {name}"),
        )),
    }
}

async fn call_model(
    client: &Client,
    cfg: &ChatConfig,
    messages: &[ModelMessage],
    tools: &[Value],
) -> Result<ModelResponse, (StatusCode, Json<ErrorResponse>)> {
    let payload = OpenAiRequest {
        model: &cfg.model,
        messages,
        tools,
        tool_choice: "auto",
        temperature: 0.2,
        max_tokens: cfg.max_tokens,
    };

    let url = normalize_openai_base_url(&cfg.base_url);
    let response = client
        .post(url)
        .header("Authorization", format!("Bearer {}", cfg.api_key))
        .json(&payload)
        .send()
        .await
        .map_err(|error| {
            json_error(
                StatusCode::BAD_GATEWAY,
                &format!("failed to call model endpoint: {error}"),
            )
        })?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response
            .text()
            .await
            .unwrap_or_else(|_| "unable to read error body".to_string());
        return Err(json_error(
            StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY),
            &format!("model endpoint failed with {status}: {body}"),
        ));
    }

    response.json::<ModelResponse>().await.map_err(|error| {
        json_error(
            StatusCode::BAD_GATEWAY,
            &format!("failed to decode model response: {error}"),
        )
    })
}

pub async fn chat(
    State(state): State<AppState>,
    Extension(auth_user): Extension<Option<AuthUser>>,
    Json(body): Json<ChatRequest>,
) -> Result<impl IntoResponse, (StatusCode, Json<ErrorResponse>)> {
    let user =
        auth_user.ok_or_else(|| json_error(StatusCode::UNAUTHORIZED, "not authenticated"))?;
    if !is_paid_role(&user.role.to_lowercase()) {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "chat is available on coffee or pro plans",
        ));
    }

    let message = body.message.trim();
    if message.is_empty() {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "message must not be empty",
        ));
    }

    let cfg = chat_config()?;

    let client = Client::builder()
        .timeout(Duration::from_secs(cfg.request_timeout_secs))
        .build()
        .map_err(|error| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("failed to create model client: {error}"),
            )
        })?;

    let tool_defs = tool_definitions();
    let mut messages = vec![
        ModelMessage {
            role: "system".to_string(),
            content: Some(system_prompt().to_string()),
            tool_calls: None,
            tool_call_id: None,
            name: None,
        },
        ModelMessage {
            role: "user".to_string(),
            content: Some(message.to_string()),
            tool_calls: None,
            tool_call_id: None,
            name: None,
        },
    ];

    let mut used_tools: Vec<ChatToolCallLog> = Vec::new();
    for _ in 0..cfg.max_tool_iterations {
        let response = call_model(&client, &cfg, &messages, &tool_defs).await?;
        let assistant = match response.choices.first() {
            Some(choice) => choice.message.clone(),
            None => {
                return Err(json_error(
                    StatusCode::BAD_GATEWAY,
                    "model response had no choices",
                ))
            }
        };

        if let Some(tool_calls) = &assistant.tool_calls {
            if tool_calls.is_empty() {
                if let Some(content) = &assistant.content {
                    if !content.trim().is_empty() {
                        return Ok(Json(ChatResponse {
                            answer: content.clone(),
                            tools: used_tools,
                            model: cfg.model,
                        }));
                    }
                }
            } else {
                if tool_calls.len() > cfg.max_tool_calls_per_turn {
                    return Err(json_error(
                        StatusCode::BAD_REQUEST,
                        "tool call limit exceeded for one model turn",
                    ));
                }

                messages.push(ModelMessage {
                    role: "assistant".to_string(),
                    content: None,
                    tool_calls: Some(tool_calls.clone()),
                    tool_call_id: None,
                    name: None,
                });

                for tool_call in tool_calls {
                    let tool_result = execute_tool(
                        &state,
                        &user,
                        tool_call,
                        &cfg.limits,
                        cfg.tool_result_max_chars,
                    )
                    .await?;
                    used_tools.push(tool_result.clone());
                    messages.push(ModelMessage {
                        role: "tool".to_string(),
                        content: Some(tool_result.result),
                        tool_call_id: Some(tool_call.id.clone()),
                        name: Some(tool_call.function.name.clone()),
                        tool_calls: None,
                    });
                }

                continue;
            }
        }

        if let Some(content) = assistant.content {
            if !content.trim().is_empty() {
                return Ok(Json(ChatResponse {
                    answer: content,
                    tools: used_tools,
                    model: cfg.model,
                }));
            }
        }
    }

    Err(json_error(
        StatusCode::BAD_REQUEST,
        "tool calls exceeded configured chat depth",
    ))
}

#[cfg(test)]
mod tests {
    use axum::http::StatusCode;

    use super::{chat_provider_unconfigured_error, non_blank_env_value};

    #[test]
    fn non_blank_env_value_ignores_empty_or_whitespace() {
        assert_eq!(non_blank_env_value(String::new()), None);
        assert_eq!(non_blank_env_value("   ".to_string()), None);
        assert_eq!(non_blank_env_value("\n\t".to_string()), None);
    }

    #[test]
    fn non_blank_env_value_trims_config_values() {
        assert_eq!(
            non_blank_env_value("  https://api.moonshot.ai/v1  ".to_string()),
            Some("https://api.moonshot.ai/v1".to_string())
        );
    }

    #[test]
    fn chat_provider_unconfigured_returns_service_unavailable() {
        let (status, _) = chat_provider_unconfigured_error();
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    }
}
