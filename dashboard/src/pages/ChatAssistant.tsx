import { FormEvent, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useClient, useQuery } from "urql";

import { useAuth } from "../auth/useAuth";
import {
  HOURLY_DELAYS,
  NETWORK_SUMMARY,
  ROUTE_RELIABILITY,
  STATION_BOARD,
  STATION_DELAY_STATS,
  STATIONS,
  TRAIN_JOURNEY,
} from "../graphql/queries";
import { delayLabel, formatTime } from "../utils/format";

interface ToolCall {
  name: string;
  details: string;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  tools?: ToolCall[];
}

interface StationRecord {
  stationCode: string;
  stationDesc: string;
}

interface StationBoardEvent {
  trainCode: string;
  origin: string | null;
  destination: string | null;
  status: string | null;
  scheduledArrival: string | null;
  scheduledDeparture: string | null;
  expectedArrival: string | null;
  expectedDeparture: string | null;
  lateMinutes: number | null;
  dueIn: number | null;
}

interface TrainJourneyRow {
  trainCode: string;
  locationFullName: string | null;
  locationOrder: number;
  trainOrigin: string | null;
  trainDestination: string | null;
  scheduledArrival: string | null;
  scheduledDeparture: string | null;
  expectedArrival: string | null;
  expectedDeparture: string | null;
  actualArrival: string | null;
  actualDeparture: string | null;
}

interface RouteReliabilityRow {
  origin: string;
  destination: string;
  avgLateMinutes: number;
  onTimePct: number;
  trainCount: number;
}

interface StationDelayStat {
  stationCode: string;
  stationDesc: string;
  avgLateMinutes: number;
  maxLateMinutes: number;
  onTimePct: number;
  totalEvents: number;
}

interface HourlyDelayRow {
  hour: string;
  stationCode: string | null;
  avgLateMinutes: number | null;
  maxLateMinutes: number | null;
  eventCount: number | null;
}

interface NetworkSummary {
  activeTrains: number;
  totalStations: number;
  avgDelayMinutes: number;
  onTimePct: number;
  lastUpdated: string | null;
}

interface StationsQuery {
  stations: StationRecord[];
}

interface StationBoardQuery {
  stationBoard: StationBoardEvent[];
}

interface TrainJourneyQuery {
  trainJourney: TrainJourneyRow[];
}

interface RouteReliabilityQuery {
  routeReliability: RouteReliabilityRow[];
}

interface StationDelayStatsQuery {
  stationDelayStats: StationDelayStat[];
}

interface HourlyDelaysQuery {
  hourlyDelays: HourlyDelayRow[];
}

interface NetworkSummaryQuery {
  networkSummary: NetworkSummary;
}

const TRAIN_CODE_RE = /\b(?:[A-Za-z]{1,3}\d{2,6}|\d{2,6}[A-Za-z]{1,3})\b/i;
const TIME_RE = /\b([01]?\d|2[0-3])(?:[:.\s])([0-5]\d)\b/;
const DESTINATION_MARKER_RE = /\b(?:to|for|towards)\s+([a-z0-9'\- ]{2,40})/i;
const ROUTE_MARKER_RE = /\b(from|to|towards|toward|between)\b/i;
const PREDICTION_HINT_RE = /\b(predict|likely|probab|typically|usually|often|histor(y|ical)|forecast|trend|average|avg)\b/i;
const NETWORK_HINT_RE = /\b(network|overall|system|global|general|as a whole|service|rail)\b/i;

function normalizeText(raw: string): string {
  return raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pickStationFromText(raw: string, stations: StationRecord[]) {
  const normalized = normalizeText(raw);
  const tokens = normalized.split(" ");

  const codeMatch = stations.find((station) => tokens.includes(normalizeText(station.stationCode)));
  if (codeMatch) {
    return codeMatch;
  }

  const candidates = stations
    .map((station) => {
      const desc = normalizeText(station.stationDesc);
      return {
        station,
        score: desc.length > 0 && normalized.includes(desc) ? desc.length : 0,
      };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  return candidates.length > 0 ? candidates[0].station : null;
}

function parseDestination(raw: string, stations: StationRecord[]) {
  const match = raw.match(DESTINATION_MARKER_RE);
  if (!match) {
    return null;
  }

  const phrase = match[1].split(" ").slice(0, 4).join(" ");
  return pickStationFromText(phrase, stations);
}

function parseRoute(raw: string, stations: StationRecord[]): {
  origin: StationRecord | null;
  destination: StationRecord | null;
} {
  const fromMatch = raw.match(/\bfrom\s+([a-z0-9'\- ]{2,40})/i);
  const toMatch = raw.match(/\b(?:to|towards|toward)\s+([a-z0-9'\- ]{2,40})/i);
  const betweenMatch = raw.match(/\bbetween\s+([a-z0-9'\- ]{2,40})\s+and\s+([a-z0-9'\- ]{2,40})/i);

  const origin = fromMatch
    ? pickStationFromText(fromMatch[1].split(" ").slice(0, 4).join(" "), stations)
    : betweenMatch
      ? pickStationFromText(betweenMatch[1], stations)
      : null;
  const destination = toMatch
    ? pickStationFromText(toMatch[1].split(" ").slice(0, 4).join(" "), stations)
    : betweenMatch
      ? pickStationFromText(betweenMatch[2], stations)
      : null;

  return { origin, destination };
}

function parseTrainCode(raw: string): string | null {
  const match = raw.match(TRAIN_CODE_RE);
  return match ? match[0].toUpperCase() : null;
}

function parseTime(raw: string): string | null {
  const match = raw.match(TIME_RE);
  if (!match) {
    return null;
  }
  const hour = match[1].padStart(2, "0");
  return `${hour}:${match[2]}`;
}

function stationMatchesRouteStation(station: StationRecord, label: string): boolean {
  const normalizedLabel = normalizeText(label);
  const normalizedDesc = normalizeText(station.stationDesc);
  return (
    normalizeText(station.stationCode) === normalizedLabel ||
    normalizedDesc === normalizedLabel ||
    (normalizedDesc.length > 3 && normalizedDesc.includes(normalizedLabel)) ||
    (normalizedLabel.length > 3 && normalizedLabel.includes(normalizedDesc))
  );
}

function formatRoutePrediction(route: RouteReliabilityRow): string {
  const reliability = `${route.onTimePct.toFixed(1)}%`;
  return `${route.origin}→${route.destination}: avg delay ${route.avgLateMinutes.toFixed(1)} min, on-time ${reliability}, based on ${route.trainCount} observed trains.`;
}

function formatStationPrediction(
  station: StationRecord,
  rows: HourlyDelayRow[],
  fallback: StationDelayStat | null,
) {
  const relevant = rows.filter((r) => r.stationCode === station.stationCode);
  const latest = relevant[0];
  const window = fallback
    ? `From the last 24h sample, ${fallback.stationDesc} averages ${fallback.avgLateMinutes.toFixed(1)} min late.`
    : "Not enough trend data for a precise estimate.";
  const latestText =
    latest && latest.avgLateMinutes !== null
      ? `Latest hour snapshot is ${latest.avgLateMinutes.toFixed(1)} min late (max ${latest.maxLateMinutes ?? 0} min).`
      : null;

  return `${station.stationDesc}: ${window} ${
    latestText ? `${latestText} ` : ""
  }Historical on-time rate: ${fallback?.onTimePct != null ? fallback.onTimePct.toFixed(1) : "n/a"}%.`;
}

function createMessageId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function formatArrivalLine(event: StationBoardEvent): string {
  const expected = event.expectedArrival || event.expectedDeparture;
  const scheduled = event.scheduledArrival || event.scheduledDeparture;

  const expectedText = expected ? formatTime(expected) : "unknown";
  const scheduledText = scheduled ? formatTime(scheduled) : "unknown";
  const lateText = event.lateMinutes == null ? "delay unknown" : delayLabel(event.lateMinutes);
  const dueInText = event.dueIn == null ? "unknown" : `${event.dueIn} min`;
  const destination = event.destination || "unknown destination";
  const status = event.status || "no status";

  return `${event.trainCode}: ${destination}, expected ${expectedText} (scheduled ${scheduledText}), ${lateText}, due in ${dueInText}. ${status}.`;
}

function rankBoardMatches(
  events: StationBoardEvent[],
  trainCode: string | null,
  scheduledTime: string | null,
  destinationText: string | null,
) {
  const needleTime = scheduledTime;
  const destinationNeedle = destinationText ? normalizeText(destinationText) : null;
  const codeNeedle = trainCode ? trainCode.toLowerCase() : null;

  return events.filter((event) => {
    if (codeNeedle && event.trainCode.toLowerCase() !== codeNeedle) {
      return false;
    }

    if (destinationNeedle) {
      const dest = normalizeText(event.destination || "");
      if (!dest.includes(destinationNeedle)) {
        return false;
      }
    }

    if (needleTime) {
      const matchTime = [
        event.scheduledArrival,
        event.expectedArrival,
        event.scheduledDeparture,
        event.expectedDeparture,
      ].some((entry) => (entry ? formatTime(entry) : "") === needleTime);
      if (!matchTime) {
        return false;
      }
    }

    return true;
  });
}

function bestBoardEvent(events: StationBoardEvent[]) {
  if (events.length === 0) {
    return null;
  }

  return [...events].sort((a, b) => {
    const aDue = a.dueIn ?? Number.MAX_SAFE_INTEGER;
    const bDue = b.dueIn ?? Number.MAX_SAFE_INTEGER;
    return aDue - bDue;
  })[0];
}

async function fetchStationBoard(client: ReturnType<typeof useClient>, stationCode: string) {
  const result = await client
    .query<StationBoardQuery>(STATION_BOARD, {
      stationCode,
      limit: 120,
    })
    .toPromise();

  if (result.error) {
    throw new Error(result.error.message);
  }

  return result.data?.stationBoard ?? [];
}

async function fetchTrainJourney(client: ReturnType<typeof useClient>, trainCode: string) {
  const result = await client
    .query<TrainJourneyQuery>(TRAIN_JOURNEY, {
      trainCode,
    })
    .toPromise();

  if (result.error) {
    throw new Error(result.error.message);
  }

  return result.data?.trainJourney ?? [];
}

async function fetchRouteReliability(
  client: ReturnType<typeof useClient>,
  hours = 168,
  minTrains = 3,
) {
  const result = await client
    .query<RouteReliabilityQuery>(ROUTE_RELIABILITY, {
      hours,
      minTrains,
    })
    .toPromise();

  if (result.error) {
    throw new Error(result.error.message);
  }

  return result.data?.routeReliability ?? [];
}

async function fetchStationDelayStats(client: ReturnType<typeof useClient>, hours = 24, limit = 20) {
  const result = await client
    .query<StationDelayStatsQuery>(STATION_DELAY_STATS, {
      hours,
      limit,
    })
    .toPromise();

  if (result.error) {
    throw new Error(result.error.message);
  }

  return result.data?.stationDelayStats ?? [];
}

async function fetchHourlyDelays(client: ReturnType<typeof useClient>, stationCode?: string, hours = 24) {
  const result = await client
    .query<HourlyDelaysQuery>(HOURLY_DELAYS, {
      stationCode,
      hours,
    })
    .toPromise();

  if (result.error) {
    throw new Error(result.error.message);
  }

  return result.data?.hourlyDelays ?? [];
}

async function fetchNetworkSummary(client: ReturnType<typeof useClient>) {
  const result = await client
    .query<NetworkSummaryQuery>(NETWORK_SUMMARY)
    .toPromise();

  if (result.error) {
    throw new Error(result.error.message);
  }

  return result.data?.networkSummary ?? null;
}

export default function ChatAssistant() {
  const { user, loading: authLoading } = useAuth();
  const isPaid = user?.role !== "free";

  const client = useClient();
  const [{ data: stationsResponse }] = useQuery<StationsQuery>({ query: STATIONS });
  const stations = useMemo(() => stationsResponse?.stations ?? [], [stationsResponse]);

  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "seed",
      role: "assistant",
      text: 'Ask me about arrivals, delays, route reliability, and delay history. Try: “How late is the 10.10 to Dublin?” or “Which route is most reliable: Heuston to Dublin?”',
      tools: [{ name: "assistant_tools", details: "station_board, train_journey, route_reliability, station_delay_stats, hourly_delays, network_summary" }],
    },
  ]);
  const [loading, setLoading] = useState(false);
  const [submitError, setSubmitError] = useState("");

  async function answerQuestion(raw: string): Promise<Pick<ChatMessage, "text" | "tools">> {
    if (!stations.length) {
      return {
        text: "I am still loading station data. Try again in a second.",
        tools: [],
      };
    }

    const stationMention = pickStationFromText(raw, stations);
    const destinationStation = parseDestination(raw, stations);
    const route = parseRoute(raw, stations);
    const station = stationMention || destinationStation;
    const routeStation = route.origin || route.destination;
    const stationForPrediction = station || routeStation;

    const trainCode = parseTrainCode(raw);
    const scheduledTime = parseTime(raw);
    const wantsDelay = /\blate\b|\bdelay\b/i.test(raw);
    const wantsPrediction = PREDICTION_HINT_RE.test(raw);
    const wantsArrival = /\barriv|depart|\bdue|\bwhen\b/i.test(raw);
    const wantsTimetable = /\btimetable|schedule|next service|next train|upcoming|servic/i.test(raw);
    const wantsNetwork = NETWORK_HINT_RE.test(raw);
    const wantsJourney = /\bjourney|\bwhere|\bposition|\broute\b/i.test(raw);
    const wantsRoute = ROUTE_MARKER_RE.test(raw) && (route.origin || route.destination);
    const toolLog: ToolCall[] = [];

    const destinationFilter =
      destinationStation && station && destinationStation.stationCode !== station.stationCode
        ? destinationStation.stationDesc
        : null;

    if (wantsNetwork && !stationForPrediction && !wantsRoute && !trainCode && !scheduledTime) {
      const summary = await fetchNetworkSummary(client);
      toolLog.push({ name: "network_summary", details: "no args" });

      if (!summary) {
        return {
          text: "Network summary is available but empty in this window.",
          tools: toolLog,
        };
      }

      return {
        text: `${summary.activeTrains} active trains, ${summary.totalStations} stations monitored. Avg delay ${summary.avgDelayMinutes.toFixed(
          1,
        )} min; on-time ${summary.onTimePct.toFixed(1)}%.`,
        tools: toolLog,
      };
    }

    if (
      wantsRoute &&
      !wantsArrival &&
      !wantsDelay &&
      !wantsPrediction &&
      !wantsNetwork &&
      !station
    ) {
      if (!route.origin || !route.destination) {
        return {
          text: "Tell me both ends, like: “What is the reliability between Heuston and Dublin?”",
          tools: [],
        };
      }
    }

    if (wantsRoute || wantsPrediction) {
      if (route.origin && route.destination) {
        const routes = await fetchRouteReliability(client);
        toolLog.push({
          name: "route_reliability",
          details: `origin=${route.origin.stationCode}, destination=${route.destination.stationCode}`,
        });

        const exact = routes.find(
          (r) =>
            stationMatchesRouteStation(route.origin!, r.origin) &&
            stationMatchesRouteStation(route.destination!, r.destination),
        );

        if (exact) {
          return {
            text: `Route knowledge for ${route.origin.stationDesc}→${route.destination.stationDesc}: ${formatRoutePrediction(
              exact,
            )}`,
            tools: toolLog,
          };
        }

        const reverse = routes.find(
          (r) =>
            stationMatchesRouteStation(route.destination!, r.origin) &&
            stationMatchesRouteStation(route.origin!, r.destination),
        );
        if (reverse) {
          return {
            text: `I only found reverse-route data for your pair. ${route.destination.stationDesc}→${route.origin.stationDesc}: ${formatRoutePrediction(
              reverse,
            )} (direction appears swapped from available data).`,
            tools: toolLog,
          };
        }

        return {
          text: `I don’t have enough recent train history for ${route.origin.stationDesc}→${route.destination.stationDesc} yet.`,
          tools: toolLog,
        };
      }

      if (wantsPrediction && stationForPrediction) {
        const [hourly, stats] = await Promise.all([
          fetchHourlyDelays(client, stationForPrediction.stationCode, 24),
          fetchStationDelayStats(client, 168, 30),
        ]);
        toolLog.push({
          name: "hourly_delays",
          details: `stationCode=${stationForPrediction.stationCode}, hours=24`,
        });
        toolLog.push({
          name: "station_delay_stats",
          details: `hours=168, limit=30`,
        });

        const stationStat = stats.find((s) => s.stationCode === stationForPrediction.stationCode) ?? null;
        return {
          text: formatStationPrediction(stationForPrediction, hourly, stationStat),
          tools: toolLog,
        };
      }
    }

    if ((wantsJourney || wantsDelay || trainCode) && !station) {
      if (trainCode) {
        const journey = await fetchTrainJourney(client, trainCode);
        toolLog.push({ name: "train_journey", details: `trainCode=${trainCode}` });

        if (journey.length === 0) {
      return {
        text: `No journey records found for train ${trainCode}.`,
        tools: toolLog,
      };
    }

        const ordered = [...journey].sort((a, b) => a.locationOrder - b.locationOrder);
        const last = ordered[ordered.length - 1];
        const destination = last.trainDestination || "unknown";
        const lastExpected =
          last.actualArrival ||
          last.actualDeparture ||
          last.expectedArrival ||
          last.expectedDeparture ||
          null;

        const lastScheduled = last.scheduledArrival || last.scheduledDeparture;

        return {
          text: `Train ${trainCode} runs ${last.trainOrigin || "somewhere"} to ${destination}. Last reported stop: ${
            last.locationFullName || "current location"
          }. Expected: ${formatTime(lastExpected)} (scheduled ${formatTime(lastScheduled)}).`,
          tools: toolLog,
        };
      }
    }

    if (station && (wantsArrival || wantsDelay || scheduledTime || trainCode || wantsJourney)) {
      const board = await fetchStationBoard(client, station.stationCode);
      toolLog.push({
        name: "station_board",
        details: `stationCode=${station.stationCode}, limit=120`,
      });

      const filtered = rankBoardMatches(board, trainCode, scheduledTime, destinationFilter);
      if (filtered.length === 0) {
        return {
          text: `No matching trains found at ${station.stationDesc} for that query.`,
          tools: toolLog,
        };
      }

      if (wantsTimetable && !scheduledTime && !trainCode && !wantsJourney) {
        const timetableEvents = [...filtered]
          .sort((a, b) => {
            const adue = a.dueIn ?? Number.MAX_SAFE_INTEGER;
            const bdue = b.dueIn ?? Number.MAX_SAFE_INTEGER;
            return adue - bdue;
          })
          .slice(0, 3);

        return {
          text: `Next services from ${station.stationDesc}: ${timetableEvents
            .map((event) => `${event.trainCode} to ${event.destination || "?"} at ${formatTime(event.expectedDeparture || event.expectedArrival || event.scheduledDeparture || event.scheduledArrival || null)}`)
            .join(" | ")}`,
          tools: toolLog,
        };
      }

      const best = bestBoardEvent(filtered);
      if (!best) {
        return {
          text: `No matching service result at ${station.stationDesc} after filtering.`,
          tools: toolLog,
        };
      }

      return {
        text: `At ${station.stationDesc}: ${formatArrivalLine(best)}.`,
        tools: toolLog,
      };
    }

    if (trainCode) {
      return {
        text:
          "I can answer delayed/arrival queries best with a station context. For example: “How late is 10.10 to Dublin?”",
        tools: toolLog,
      };
    }

    return {
      text:
        "Tell me a station and either a time or a train code, or ask a route/trend question, for example: “When is the 10.10 to Dublin?”, “How likely is it to be late at Heuston?”, or “Which is more reliable, Heuston to Dublin or Heuston to Cork?”",
      tools: [],
    };
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!question.trim() || loading || !isPaid) {
      return;
    }

    const prompt = question.trim();
    setQuestion("");
    const assistantMessageId = createMessageId();
    const userMessageId = createMessageId();

    setMessages((state) => [
      ...state,
      {
        id: userMessageId,
        role: "user",
        text: prompt,
      },
      {
        id: assistantMessageId,
        role: "assistant",
        text: "Running tools…",
        tools: [],
      },
    ]);

    setLoading(true);
    setSubmitError("");
    try {
      const answer = await answerQuestion(prompt);
      setMessages((state) =>
        state.map((item) =>
          item.id === assistantMessageId
            ? {
                ...item,
                text: answer.text,
                tools: answer.tools,
              }
            : item,
        ),
      );
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "tooling failed");
      setMessages((state) =>
        state.map((item) =>
          item.id === assistantMessageId
            ? {
                ...item,
                text: "I couldn't process that request. Try a simpler question with station name, time, or train code.",
                tools: [],
              }
            : item,
        ),
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-0 space-y-4 p-6">
      <h2 className="text-xl font-bold text-white">Rail Assistant</h2>
      <p className="text-sm text-[var(--rail-muted)]">
        Ask about arrivals and delays. The assistant runs live data tools and returns sourced answers.
      </p>

      {authLoading ? (
        <p className="text-sm text-[var(--rail-muted)]">Loading account…</p>
      ) : !isPaid ? (
        <div className="rounded-lg border border-[var(--rail-border)] bg-[var(--rail-surface)] p-4 text-sm text-[var(--rail-muted)]">
          AI tools are available on Coffee or Pro plans. 
          <Link to="/pricing" className="text-[var(--rail-green)] underline">
            Upgrade here
          </Link>
          .
        </div>
      ) : null}

      <div className="h-[58vh] space-y-3 overflow-auto rounded-lg border border-[var(--rail-border)] bg-[var(--rail-surface)] p-4">
        {messages.map((message) => (
          <div key={message.id} className="space-y-2">
            <p
              className={message.role === "user" ? "text-sm text-white" : "text-sm text-[var(--rail-green)]"}
            >
              <span className="mr-2 font-semibold">{message.role === "user" ? "You" : "Assistant"}:</span>
              {message.text}
            </p>
            {message.tools && message.tools.length > 0 && (
              <div className="text-xs text-[var(--rail-muted)]">
                <p>Tools:</p>
                <ul className="ml-4 list-disc">
                  {message.tools.map((tool) => (
                    <li key={`${tool.name}-${tool.details}`}>
                      {tool.name} · {tool.details}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ))}
      </div>

      {submitError ? <p className="text-sm text-[var(--rail-red)]">{submitError}</p> : null}

      <form onSubmit={onSubmit} className="flex gap-3">
        <input
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="Ask: When is the 10.10 to Dublin?"
          className="flex-1 rounded bg-[var(--rail-bg)] border border-[var(--rail-border)] px-3 py-2 text-sm text-white focus:outline-none focus:border-[var(--rail-green)]"
          disabled={loading || !isPaid}
        />
        <button
          type="submit"
          disabled={loading || !question.trim() || !isPaid}
          className="rounded bg-[var(--rail-green)] px-4 py-2 text-sm font-medium text-black disabled:opacity-60"
        >
          {loading ? "Asking…" : "Ask"}
        </button>
      </form>
    </div>
  );
}
