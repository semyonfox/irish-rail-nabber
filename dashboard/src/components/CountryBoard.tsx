import { useEffect, useMemo, useState } from "react";
import { COUNTRY_BOARD } from "../graphql/queries";
import { usePollingQuery } from "../utils/usePollingQuery";
import { delayColor, formatTime } from "../utils/format";

interface BoardEvent {
  trainCode: string;
  stationCode: string;
  stationDesc: string;
  trainDate: string | null;
  origin: string | null;
  destination: string | null;
  trainType: string | null;
  direction: string | null;
  status: string | null;
  scheduledArrival: string | null;
  scheduledDeparture: string | null;
  expectedArrival: string | null;
  expectedDeparture: string | null;
  lateMinutes: number | null;
  lastLocation: string | null;
  dueIn: number | null;
  fetchedAt: string;
}

interface CountryBoardData {
  countryBoard: BoardEvent[];
}

interface Props {
  limit?: number;
  minutes?: number;
  compact?: boolean;
}

type Mode = "critical" | "soon" | "all";

const modes: { id: Mode; label: string }[] = [
  { id: "critical", label: "Critical" },
  { id: "soon", label: "Next" },
  { id: "all", label: "All" },
];

const windowOptions = [15, 30, 60, 90, 180];

const updatedFormat = new Intl.DateTimeFormat("en-IE", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function isRealTime(time: string | null | undefined) {
  return Boolean(time && time !== "00:00:00");
}

function pickTime(...times: (string | null | undefined)[]) {
  return times.find(isRealTime) ?? null;
}

function eventKind(row: BoardEvent) {
  if (pickTime(row.expectedDeparture, row.scheduledDeparture)) return "Dep";
  if (pickTime(row.expectedArrival, row.scheduledArrival)) return "Arr";
  return "-";
}

function eventTime(row: BoardEvent) {
  const expected =
    eventKind(row) === "Dep"
      ? pickTime(row.expectedDeparture, row.scheduledDeparture)
      : pickTime(row.expectedArrival, row.scheduledArrival);
  return formatTime(expected);
}

function scheduledTime(row: BoardEvent) {
  const scheduled =
    eventKind(row) === "Dep" ? pickTime(row.scheduledDeparture) : pickTime(row.scheduledArrival);
  return formatTime(scheduled);
}

function routeLabel(row: BoardEvent) {
  if (row.origin && row.destination) return `${row.origin} to ${row.destination}`;
  return row.direction || "Route unknown";
}

function dueLabel(dueIn: number | null) {
  if (dueIn == null) return "-";
  if (dueIn < 0) return "Left";
  if (dueIn === 0) return "Due";
  return `${dueIn}m`;
}

function delayLabel(minutes: number | null) {
  if (minutes == null) return "-";
  if (minutes <= 0) return "RT";
  return `+${minutes}`;
}

function pressureScore(row: BoardEvent) {
  const delay = row.lateMinutes ?? 0;
  const due = row.dueIn ?? 999;
  if (delay >= 15) return 8;
  if (delay >= 5) return 5;
  if (due >= 0 && due <= 5) return 3;
  if (due >= 0 && due <= 10) return 2;
  return 0;
}

function rowTone(row: BoardEvent) {
  if ((row.lateMinutes ?? 0) >= 15) return "border-l-[var(--rail-red)] bg-[rgba(208,59,59,0.06)]";
  if ((row.lateMinutes ?? 0) >= 5) return "border-l-[var(--rail-warn)]";
  if (row.dueIn != null && row.dueIn <= 5) return "border-l-[var(--rail-border-strong)]";
  return "border-l-transparent";
}

export default function CountryBoard({ limit = 90, minutes = 45, compact = false }: Props) {
  const [mode, setMode] = useState<Mode>("critical");
  const [windowMinutes, setWindowMinutes] = useState(minutes);
  const [filter, setFilter] = useState("");
  const [paused, setPaused] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  const [{ data, fetching, error }, refresh] = usePollingQuery<CountryBoardData>({
    query: COUNTRY_BOARD,
    variables: { limit, minutes: windowMinutes },
    pollInterval: 15000,
    pause: paused,
  });

  useEffect(() => {
    if (data) setUpdatedAt(new Date());
  }, [data]);

  const rows = useMemo(() => data?.countryBoard ?? [], [data?.countryBoard]);
  const delayedRows = rows.filter((row) => (row.lateMinutes ?? 0) >= 5);
  const severeRows = rows.filter((row) => (row.lateMinutes ?? 0) >= 15);
  const dueRows = rows.filter((row) => row.dueIn != null && row.dueIn >= 0 && row.dueIn <= 10);
  const topDelay =
    rows.reduce<BoardEvent | null>((top, row) => {
      if (!top) return row;
      return (row.lateMinutes ?? 0) > (top.lateMinutes ?? 0) ? row : top;
    }, null) ?? null;
  const worstDelay = topDelay?.lateMinutes ?? 0;
  const hasDelaySpotlight = topDelay != null && worstDelay > 0;
  const busiestStation = useMemo(() => {
    const stations = new Map<
      string,
      {
        stationCode: string;
        stationDesc: string;
        due: number;
        late: number;
        severe: number;
        score: number;
        worstDelay: number;
      }
    >();

    for (const row of rows) {
      const current = stations.get(row.stationCode) ?? {
        stationCode: row.stationCode,
        stationDesc: row.stationDesc,
        due: 0,
        late: 0,
        severe: 0,
        score: 0,
        worstDelay: 0,
      };
      const delay = row.lateMinutes ?? 0;
      if (row.dueIn != null && row.dueIn >= 0 && row.dueIn <= 10) current.due += 1;
      if (delay >= 5) current.late += 1;
      if (delay >= 15) current.severe += 1;
      current.score += pressureScore(row);
      current.worstDelay = Math.max(current.worstDelay, delay);
      stations.set(row.stationCode, current);
    }

    return [...stations.values()]
      .filter((station) => station.score > 0)
      .sort((a, b) => b.score - a.score || b.worstDelay - a.worstDelay)
      .slice(0, compact ? 2 : 4);
  }, [compact, rows]);
  const boardState =
    severeRows.length > 0
      ? `${severeRows.length} severe delays need attention`
      : delayedRows.length > 0
        ? `${delayedRows.length} delayed services on the board`
        : dueRows.length > 0
          ? `${dueRows.length} services due inside 10 minutes`
          : "Board is quiet in the current window";

  const filterNeedle = filter.trim().toLowerCase();
  const visibleRows = useMemo(() => {
    const byMode =
      mode === "critical"
        ? rows.filter(
            (row) => (row.lateMinutes ?? 0) >= 5 || (row.dueIn != null && row.dueIn <= 10),
          )
        : mode === "soon"
          ? rows
              .filter((row) => row.dueIn != null && row.dueIn >= -2)
              .sort((a, b) => (a.dueIn ?? 9999) - (b.dueIn ?? 9999))
          : rows;

    const base = byMode.length ? byMode : rows;
    const searched = filterNeedle
      ? base.filter((row) =>
          [row.trainCode, row.stationCode, row.stationDesc, row.origin, row.destination]
            .filter(Boolean)
            .some((field) => String(field).toLowerCase().includes(filterNeedle)),
        )
      : base;

    return searched.slice(0, compact ? 12 : 36);
  }, [compact, filterNeedle, mode, rows]);

  return (
    <section className="term-panel overflow-hidden">
      <div className="term-panel-head">
        Live network board
        <small>{boardState}</small>
        <span className="term-panel-meta">
          {paused ? (
            <span className="text-[var(--rail-warn)]">FEED HELD</span>
          ) : (
            <span>UPD {updatedAt ? updatedFormat.format(updatedAt) : "--:--:--"}</span>
          )}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--rail-border)] bg-[var(--rail-surface)] px-3 py-2">
        <div className="term-toggle" role="group" aria-label="Board filter mode">
          {modes.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setMode(item.id)}
              className={mode === item.id ? "is-on" : ""}
            >
              {item.label}
            </button>
          ))}
        </div>
        <select
          value={windowMinutes}
          onChange={(event) => setWindowMinutes(Number(event.target.value))}
          className="term-control"
          aria-label="Board time window"
        >
          {windowOptions.map((option) => (
            <option key={option} value={option}>
              {option} min window
            </option>
          ))}
        </select>
        <input
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter station / train / route"
          className="term-control w-56 max-w-full"
          aria-label="Filter board rows"
        />
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            className="term-btn"
            aria-pressed={paused}
            onClick={() => {
              setPaused((current) => {
                if (current) refresh({ requestPolicy: "network-only" });
                return !current;
              });
            }}
          >
            {paused ? "Resume feed" : "Hold feed"}
          </button>
          <button
            type="button"
            className="term-btn"
            onClick={() => refresh({ requestPolicy: "network-only" })}
            disabled={paused}
          >
            Refresh
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-px border-b border-[var(--rail-border)] bg-[var(--rail-border)] md:grid-cols-4">
        <div className="bg-[var(--rail-surface)] px-3 py-2">
          <div className="stat-tile-label">Due soon</div>
          <div className="text-lg font-bold tabular-nums text-[var(--rail-text)]">
            {dueRows.length}
          </div>
        </div>
        <div className="bg-[var(--rail-surface)] px-3 py-2">
          <div className="stat-tile-label">Late ≥5m</div>
          <div
            className="text-lg font-bold tabular-nums"
            style={{ color: delayedRows.length > 0 ? "var(--rail-warn)" : "var(--rail-text)" }}
          >
            {delayedRows.length}
          </div>
        </div>
        <div className="bg-[var(--rail-surface)] px-3 py-2">
          <div className="stat-tile-label">Severe ≥15m</div>
          <div
            className="text-lg font-bold tabular-nums"
            style={{ color: severeRows.length > 0 ? "var(--rail-red)" : "var(--rail-text)" }}
          >
            {severeRows.length}
          </div>
        </div>
        <div className="bg-[var(--rail-surface)] px-3 py-2">
          <div className="stat-tile-label">Worst</div>
          <div
            className="text-lg font-bold tabular-nums"
            style={{ color: delayColor(worstDelay > 0 ? worstDelay : 0) }}
          >
            {worstDelay > 0 ? `+${worstDelay}m` : "RT"}
          </div>
        </div>
      </div>

      {(hasDelaySpotlight || busiestStation.length > 0) && (
        <div
          className={`grid gap-px border-b border-[var(--rail-border)] bg-[var(--rail-border)] ${
            compact ? "grid-cols-1" : "lg:grid-cols-[minmax(0,1fr)_360px]"
          }`}
        >
          {hasDelaySpotlight && (
            <div className="bg-[var(--rail-surface)] px-3 py-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="stat-tile-label">Biggest drag</div>
                  <div className="mt-1 truncate text-sm font-semibold text-[var(--rail-text)]">
                    {topDelay.trainCode} · {routeLabel(topDelay)}
                  </div>
                  <div className="mt-1 truncate text-xs text-[var(--rail-muted)]">
                    {topDelay.stationDesc} · {eventTime(topDelay)} ·{" "}
                    {topDelay.lastLocation || topDelay.status || "location pending"}
                  </div>
                </div>
                <div
                  className="shrink-0 border border-current px-3 py-2 text-right"
                  style={{ color: delayColor(topDelay.lateMinutes) }}
                >
                  <div className="text-lg font-bold tabular-nums">
                    {topDelay.lateMinutes == null
                      ? "-"
                      : topDelay.lateMinutes <= 0
                        ? "RT"
                        : `+${topDelay.lateMinutes}m`}
                  </div>
                  <div className="text-[9px] uppercase tracking-widest">late</div>
                </div>
              </div>
            </div>
          )}
          {!compact && busiestStation.length > 0 && (
            <div className="bg-[var(--rail-surface)] px-3 py-3">
              <div className="stat-tile-label mb-2">Station pressure</div>
              <div className="space-y-2">
                {busiestStation.map((station) => (
                  <div
                    key={station.stationCode}
                    className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 text-sm"
                  >
                    <div className="min-w-0">
                      <div className="truncate font-medium text-[var(--rail-text)]">
                        {station.stationDesc}
                      </div>
                      <div className="text-xs text-[var(--rail-muted)]">
                        {station.due} due · {station.late} late · {station.severe} severe
                      </div>
                    </div>
                    <div
                      className="font-semibold tabular-nums"
                      style={{ color: delayColor(station.worstDelay) }}
                    >
                      +{station.worstDelay}m
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {fetching && rows.length === 0 ? (
        <div className="flex h-48 items-center justify-center text-sm text-[var(--rail-muted)]">
          Loading country board...
        </div>
      ) : error && rows.length === 0 ? (
        <div className="flex h-48 items-center justify-center text-sm text-[var(--rail-muted)]">
          Could not load live board
        </div>
      ) : visibleRows.length === 0 ? (
        <div className="flex h-48 items-center justify-center text-sm text-[var(--rail-muted)]">
          {filterNeedle
            ? `No board rows match "${filter.trim()}"`
            : "No live arrivals or departures"}
        </div>
      ) : (
        <div className="overflow-auto">
          <table className="term-table min-w-[820px]">
            <thead>
              <tr>
                <th>Due</th>
                <th>Train</th>
                <th>Station</th>
                <th>Route</th>
                <th>Time</th>
                <th>Delay</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => (
                <tr
                  key={`${row.trainCode}-${row.stationCode}-${row.trainDate ?? ""}-${row.fetchedAt}`}
                  className={`border-l-2 ${rowTone(row)}`}
                >
                  <td>
                    <div className="font-semibold text-[var(--rail-text)]">
                      {dueLabel(row.dueIn)}
                    </div>
                    <div className="text-xs text-[var(--rail-muted)]">{eventKind(row)}</div>
                  </td>
                  <td>
                    <div className="font-semibold text-[var(--rail-text)]">{row.trainCode}</div>
                    <div className="text-xs text-[var(--rail-muted)]">
                      {row.trainType || "Rail"}
                    </div>
                  </td>
                  <td>
                    <div className="font-medium text-[var(--rail-text)]">{row.stationDesc}</div>
                    <div className="text-xs text-[var(--rail-muted)]">{row.stationCode}</div>
                  </td>
                  <td className="max-w-[320px]">
                    <div className="truncate font-medium text-[var(--rail-text)]">
                      {routeLabel(row)}
                    </div>
                    <div className="truncate text-xs text-[var(--rail-muted)]">
                      {row.lastLocation ? `Last: ${row.lastLocation}` : row.direction || "-"}
                    </div>
                  </td>
                  <td>
                    <div className="font-semibold tabular-nums text-[var(--rail-text)]">
                      {eventTime(row)}
                    </div>
                    <div className="text-xs tabular-nums text-[var(--rail-muted)]">
                      Sched {scheduledTime(row)}
                    </div>
                  </td>
                  <td>
                    <span
                      className="inline-flex min-w-12 justify-center border border-current px-2 py-0.5 text-xs font-bold tabular-nums"
                      style={{ color: delayColor(row.lateMinutes) }}
                    >
                      {delayLabel(row.lateMinutes)}
                    </span>
                  </td>
                  <td className="text-[var(--rail-muted)]">{row.status || "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {compact && dueRows.length > 0 ? (
        <div className="border-t border-[var(--rail-border)] px-4 py-2 text-xs text-[var(--rail-muted)]">
          {dueRows.length} trains due inside 10 minutes
        </div>
      ) : null}
    </section>
  );
}
