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

function eventKind(row: BoardEvent) {
  return row.expectedDeparture || row.scheduledDeparture ? "Dep" : "Arr";
}

function eventTime(row: BoardEvent) {
  const expected =
    eventKind(row) === "Dep"
      ? row.expectedDeparture || row.scheduledDeparture
      : row.expectedArrival || row.scheduledArrival;
  return formatTime(expected);
}

function scheduledTime(row: BoardEvent) {
  const scheduled = eventKind(row) === "Dep" ? row.scheduledDeparture : row.scheduledArrival;
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

  const rows = data?.countryBoard ?? [];
  const delayedRows = rows.filter((row) => (row.lateMinutes ?? 0) >= 5);
  const severeRows = rows.filter((row) => (row.lateMinutes ?? 0) >= 15);
  const dueRows = rows.filter((row) => row.dueIn != null && row.dueIn >= 0 && row.dueIn <= 10);
  const worstDelay = rows.reduce((max, row) => Math.max(max, row.lateMinutes ?? 0), 0);

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
            <div className="text-xs text-[var(--rail-muted)]">Board</div>
            <div className="text-xl font-semibold text-white">{rows.length}</div>
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
            <div className="text-xl font-semibold text-white">+{worstDelay}m</div>
          </div>
        </div>
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
