import { useMemo, useState } from "react";
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
  if ((row.lateMinutes ?? 0) >= 15) return "border-l-[var(--rail-red)] bg-red-950/20";
  if ((row.lateMinutes ?? 0) >= 5) return "border-l-[var(--rail-orange)] bg-orange-950/20";
  if (row.dueIn != null && row.dueIn <= 5) return "border-l-[var(--rail-yellow)] bg-yellow-950/10";
  return "border-l-transparent";
}

export default function CountryBoard({ limit = 90, minutes = 45, compact = false }: Props) {
  const [mode, setMode] = useState<Mode>("critical");
  const [{ data, fetching, error }] = usePollingQuery<CountryBoardData>({
    query: COUNTRY_BOARD,
    variables: { limit, minutes },
    pollInterval: 15000,
  });

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

  const visibleRows = useMemo(() => {
    const filtered =
      mode === "critical"
        ? rows.filter(
            (row) => (row.lateMinutes ?? 0) >= 5 || (row.dueIn != null && row.dueIn <= 10),
          )
        : mode === "soon"
          ? rows
              .filter((row) => row.dueIn != null && row.dueIn >= -2)
              .sort((a, b) => (a.dueIn ?? 9999) - (b.dueIn ?? 9999))
          : rows;

    return (filtered.length ? filtered : rows).slice(0, compact ? 12 : 36);
  }, [compact, mode, rows]);

  return (
    <section className="overflow-hidden rounded-lg border border-[var(--rail-border)] bg-[var(--rail-surface)]">
      <div className="border-b border-[var(--rail-border)] px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase text-[var(--rail-green)]">
              Country board
            </p>
            <h2 className="text-lg font-semibold text-white">Live arrivals and departures</h2>
            <p className="mt-1 text-sm text-[var(--rail-muted)]">{boardState}</p>
          </div>
          <div className="inline-flex rounded-md border border-[var(--rail-border)] bg-[var(--rail-bg)] p-1">
            {modes.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setMode(item.id)}
                className={`rounded px-3 py-1 text-xs font-medium transition ${
                  mode === item.id
                    ? "bg-[var(--rail-green)] text-black"
                    : "text-[var(--rail-muted)] hover:text-white"
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
          <div className="rounded border border-[var(--rail-border)] bg-[var(--rail-bg)] px-3 py-2">
            <div className="text-xs text-[var(--rail-muted)]">Due soon</div>
            <div className="text-xl font-semibold text-white">{dueRows.length}</div>
          </div>
          <div className="rounded border border-[var(--rail-border)] bg-[var(--rail-bg)] px-3 py-2">
            <div className="text-xs text-[var(--rail-muted)]">Late</div>
            <div className="text-xl font-semibold text-[var(--rail-orange)]">
              {delayedRows.length}
            </div>
          </div>
          <div className="rounded border border-[var(--rail-border)] bg-[var(--rail-bg)] px-3 py-2">
            <div className="text-xs text-[var(--rail-muted)]">Severe</div>
            <div className="text-xl font-semibold text-[var(--rail-red)]">{severeRows.length}</div>
          </div>
          <div className="rounded border border-[var(--rail-border)] bg-[var(--rail-bg)] px-3 py-2">
            <div className="text-xs text-[var(--rail-muted)]">Worst</div>
            <div className="text-xl font-semibold text-white">
              {worstDelay > 0 ? `+${worstDelay}m` : "RT"}
            </div>
          </div>
        </div>

        {(hasDelaySpotlight || busiestStation.length > 0) && (
          <div
            className={`mt-3 grid gap-2 ${compact ? "grid-cols-1" : "lg:grid-cols-[minmax(0,1fr)_360px]"}`}
          >
            {hasDelaySpotlight && (
              <div className="rounded border border-[var(--rail-border)] bg-[var(--rail-bg)] px-3 py-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs uppercase text-[var(--rail-muted)]">Biggest drag</div>
                    <div className="mt-1 truncate text-sm font-semibold text-white">
                      {topDelay.trainCode} · {routeLabel(topDelay)}
                    </div>
                    <div className="mt-1 truncate text-xs text-[var(--rail-muted)]">
                      {topDelay.stationDesc} · {eventTime(topDelay)} ·{" "}
                      {topDelay.lastLocation || topDelay.status || "location pending"}
                    </div>
                  </div>
                  <div
                    className="shrink-0 rounded border border-current px-3 py-2 text-right"
                    style={{ color: delayColor(topDelay.lateMinutes) }}
                  >
                    <div className="text-xl font-bold">
                      {topDelay.lateMinutes == null
                        ? "-"
                        : topDelay.lateMinutes <= 0
                          ? "RT"
                          : `+${topDelay.lateMinutes}m`}
                    </div>
                    <div className="text-xs">late</div>
                  </div>
                </div>
              </div>
            )}
            {!compact && busiestStation.length > 0 && (
              <div className="rounded border border-[var(--rail-border)] bg-[var(--rail-bg)] px-3 py-3">
                <div className="mb-2 text-xs uppercase text-[var(--rail-muted)]">
                  Station pressure
                </div>
                <div className="space-y-2">
                  {busiestStation.map((station) => (
                    <div
                      key={station.stationCode}
                      className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 text-sm"
                    >
                      <div className="min-w-0">
                        <div className="truncate font-medium text-white">{station.stationDesc}</div>
                        <div className="text-xs text-[var(--rail-muted)]">
                          {station.due} due · {station.late} late · {station.severe} severe
                        </div>
                      </div>
                      <div className="font-semibold text-[var(--rail-orange)]">
                        +{station.worstDelay}m
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {fetching && rows.length === 0 ? (
        <div className="flex h-48 items-center justify-center text-sm text-[var(--rail-muted)]">
          Loading country board...
        </div>
      ) : error ? (
        <div className="flex h-48 items-center justify-center text-sm text-[var(--rail-muted)]">
          Could not load live board
        </div>
      ) : visibleRows.length === 0 ? (
        <div className="flex h-48 items-center justify-center text-sm text-[var(--rail-muted)]">
          No live arrivals or departures
        </div>
      ) : (
        <div className="overflow-auto">
          <table className="w-full min-w-[820px] text-sm">
            <thead className="sticky top-0 z-10 bg-[var(--rail-surface)]">
              <tr className="border-b border-[var(--rail-border)] text-left text-xs font-semibold uppercase text-[var(--rail-muted)]">
                <th className="px-3 py-2">Due</th>
                <th className="px-3 py-2">Train</th>
                <th className="px-3 py-2">Station</th>
                <th className="px-3 py-2">Route</th>
                <th className="px-3 py-2">Time</th>
                <th className="px-3 py-2">Delay</th>
                <th className="px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => (
                <tr
                  key={`${row.trainCode}-${row.stationCode}-${row.trainDate ?? ""}-${row.fetchedAt}`}
                  className={`border-l-4 border-b border-[var(--rail-border)] ${rowTone(row)}`}
                >
                  <td className="px-3 py-3">
                    <div className="font-semibold text-white">{dueLabel(row.dueIn)}</div>
                    <div className="text-xs text-[var(--rail-muted)]">{eventKind(row)}</div>
                  </td>
                  <td className="px-3 py-3">
                    <div className="font-semibold text-white">{row.trainCode}</div>
                    <div className="text-xs text-[var(--rail-muted)]">
                      {row.trainType || "Rail"}
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    <div className="font-medium text-white">{row.stationDesc}</div>
                    <div className="text-xs text-[var(--rail-muted)]">{row.stationCode}</div>
                  </td>
                  <td className="max-w-[320px] px-3 py-3">
                    <div className="truncate font-medium text-white">{routeLabel(row)}</div>
                    <div className="truncate text-xs text-[var(--rail-muted)]">
                      {row.lastLocation ? `Last: ${row.lastLocation}` : row.direction || "-"}
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    <div className="font-semibold text-white">{eventTime(row)}</div>
                    <div className="text-xs text-[var(--rail-muted)]">
                      Sched {scheduledTime(row)}
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    <span
                      className="inline-flex min-w-12 justify-center rounded border border-current px-2 py-1 text-xs font-bold"
                      style={{ color: delayColor(row.lateMinutes) }}
                    >
                      {delayLabel(row.lateMinutes)}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-[var(--rail-muted)]">{row.status || "-"}</td>
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
