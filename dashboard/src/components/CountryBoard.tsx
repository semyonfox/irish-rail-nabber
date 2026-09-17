import { useMemo, useState } from "react";
import { COUNTRY_BOARD } from "../graphql/queries";
import { usePollingQuery } from "../utils/usePollingQuery";
import { delayTone, formatTime, shortDelay } from "../utils/format";
import { Card, DelayPill, Empty, Icon, MiniStat, SearchInput, Segmented } from "./ui";

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
  index?: number;
}

type Mode = "critical" | "soon" | "all";

const modes: { value: Mode; label: string }[] = [
  { value: "critical", label: "Needs attention" },
  { value: "soon", label: "Next up" },
  { value: "all", label: "Everything" },
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
  if (row.origin && row.destination) return `${row.origin} → ${row.destination}`;
  return row.direction || "Route unknown";
}

function dueLabel(dueIn: number | null) {
  if (dueIn == null) return "-";
  if (dueIn < 0) return "Left";
  if (dueIn === 0) return "Due";
  return `${dueIn} min`;
}

function kindLabel(row: BoardEvent) {
  const kind = eventKind(row);
  if (kind === "Dep") return "Departs";
  if (kind === "Arr") return "Arrives";
  return "—";
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
  if ((row.lateMinutes ?? 0) >= 15) return "bad";
  if ((row.lateMinutes ?? 0) >= 5) return "warn";
  return undefined;
}

export default function CountryBoard({ limit = 90, minutes = 45, compact = false, index }: Props) {
  const [mode, setMode] = useState<Mode>("critical");
  const [windowMinutes, setWindowMinutes] = useState(minutes);
  const [filter, setFilter] = useState("");
  const [paused, setPaused] = useState(false);
  const [{ data, fetching, error }, refresh] = usePollingQuery<CountryBoardData>({
    query: COUNTRY_BOARD,
    variables: { limit, minutes: windowMinutes },
    pollInterval: 15000,
    pause: paused,
  });

  const rows = useMemo(() => data?.countryBoard ?? [], [data?.countryBoard]);
  const updatedAt = useMemo(() => {
    const latest = rows.reduce<string | null>((current, row) => {
      if (!current || row.fetchedAt > current) return row.fetchedAt;
      return current;
    }, null);
    if (!latest) return null;
    const parsed = new Date(latest);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }, [rows]);
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
      ? `${severeRows.length} severe ${severeRows.length === 1 ? "delay needs" : "delays need"} attention`
      : delayedRows.length > 0
        ? `${delayedRows.length} delayed services on the board`
        : dueRows.length > 0
          ? `${dueRows.length} services due inside 10 minutes`
          : "The board is quiet in this window";

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
    <Card
      index={index}
      title="Departures & arrivals"
      description={boardState}
      actions={
        <>
          <span className="code mr-1">
            {paused ? (
              <span className="text-warn">Feed paused</span>
            ) : (
              `Updated ${updatedAt ? updatedFormat.format(updatedAt) : "--:--:--"}`
            )}
          </span>
          <button
            type="button"
            className="btn btn-quiet btn-sm"
            aria-pressed={paused}
            onClick={() => {
              setPaused((current) => {
                if (current) refresh({ requestPolicy: "network-only" });
                return !current;
              });
            }}
          >
            <Icon name={paused ? "play" : "pause"} />
            {paused ? "Resume" : "Pause"}
          </button>
          <button
            type="button"
            className="btn btn-quiet btn-sm"
            onClick={() => refresh({ requestPolicy: "network-only" })}
            disabled={paused}
            aria-label="Refresh board"
            title="Refresh board"
          >
            <Icon name="refresh" />
          </button>
        </>
      }
    >
      <div className="flex flex-wrap items-center gap-2 px-5 pb-4">
        <Segmented label="Board filter" options={modes} value={mode} onChange={setMode} />
        <select
          value={windowMinutes}
          onChange={(event) => setWindowMinutes(Number(event.target.value))}
          className="control"
          aria-label="Board time window"
        >
          {windowOptions.map((option) => (
            <option key={option} value={option}>
              Next {option} min
            </option>
          ))}
        </select>
        <SearchInput
          value={filter}
          onChange={setFilter}
          placeholder="Station, train or route"
          label="Filter board rows"
          className="w-full sm:ml-auto sm:w-64"
        />
      </div>

      <div className="grid grid-cols-2 gap-2 px-5 pb-4 md:grid-cols-4">
        <MiniStat label="Due in 10 min" value={dueRows.length} />
        <MiniStat
          label="Late 5 min+"
          value={delayedRows.length}
          tone={delayedRows.length > 0 ? "warn" : undefined}
        />
        <MiniStat
          label="Severe 15 min+"
          value={severeRows.length}
          tone={severeRows.length > 0 ? "bad" : undefined}
        />
        <MiniStat label="Worst delay" value={shortDelay(worstDelay)} />
      </div>

      {hasDelaySpotlight || busiestStation.length > 0 ? (
        <div
          className={`grid items-start gap-3 px-5 pb-5 ${compact ? "grid-cols-1" : "lg:grid-cols-[minmax(0,1fr)_380px]"}`}
        >
          {hasDelaySpotlight ? (
            <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-line p-4">
              <div className="min-w-0">
                <div className="text-[12.5px] font-semibold text-muted">
                  Biggest delay right now
                </div>
                <div className="mt-1 break-words text-[17px] font-semibold tracking-[-0.01em]">
                  {routeLabel(topDelay)}
                </div>
                <div className="mt-1 break-words text-[13px] text-muted">
                  <span className="code">{topDelay.trainCode}</span> at {topDelay.stationDesc} ·{" "}
                  {eventTime(topDelay)} ·{" "}
                  {topDelay.lastLocation || topDelay.status || "location pending"}
                </div>
              </div>
              <div
                className="tone-block shrink-0 px-4 py-2.5 text-right"
                data-tone={delayTone(topDelay.lateMinutes)}
              >
                <div className="text-[26px] font-semibold leading-none tracking-[-0.03em]">
                  +{topDelay.lateMinutes}
                </div>
                <div className="mt-1 text-[11.5px] font-semibold">min late</div>
              </div>
            </div>
          ) : null}
          {!compact && busiestStation.length > 0 ? (
            <div className="rounded-2xl border border-line p-4">
              <div className="mb-2 text-[12.5px] font-semibold text-muted">
                Stations under pressure
              </div>
              <ul className="space-y-2">
                {busiestStation.map((station) => (
                  <li
                    key={station.stationCode}
                    className="flex items-center justify-between gap-3 text-[14px]"
                  >
                    <div className="min-w-0">
                      <div className="break-words font-semibold">{station.stationDesc}</div>
                      <div className="text-[12.5px] text-muted">
                        {station.due} due · {station.late} late · {station.severe} severe
                      </div>
                    </div>
                    <DelayPill minutes={station.worstDelay} />
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      {fetching && rows.length === 0 ? (
        <Empty className="border-t border-line">Loading the live board…</Empty>
      ) : error && rows.length === 0 ? (
        <Empty className="border-t border-line">Could not load the live board</Empty>
      ) : visibleRows.length === 0 ? (
        <Empty className="border-t border-line">
          {filterNeedle
            ? `Nothing on the board matches “${filter.trim()}”`
            : "No live arrivals or departures"}
        </Empty>
      ) : (
        <div className="overflow-auto">
          <table className="data-table responsive-table min-w-[860px]">
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
                  data-tone={rowTone(row)}
                >
                  <td data-label="Due">
                    <div className="cell-main">{dueLabel(row.dueIn)}</div>
                    <div className="cell-sub">{kindLabel(row)}</div>
                  </td>
                  <td data-label="Train">
                    <span className="chip">{row.trainCode}</span>
                    <div className="cell-sub">{row.trainType || "Rail"}</div>
                  </td>
                  <td data-label="Station">
                    <div className="cell-main">{row.stationDesc}</div>
                    <div className="cell-sub">{row.stationCode}</div>
                  </td>
                  <td data-label="Route" className="max-w-[320px]">
                    <div className="break-words font-medium">{routeLabel(row)}</div>
                    <div className="cell-sub break-words">
                      {row.lastLocation ? row.lastLocation : row.direction || "-"}
                    </div>
                  </td>
                  <td data-label="Time">
                    <div className="font-mono font-semibold">{eventTime(row)}</div>
                    <div className="cell-sub">Sched {scheduledTime(row)}</div>
                  </td>
                  <td data-label="Delay">
                    <DelayPill minutes={row.lateMinutes} />
                  </td>
                  <td data-label="Status" className="text-muted">
                    {row.status || "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {compact && dueRows.length > 0 ? (
        <div className="border-t border-line px-5 py-3 text-[13px] text-muted">
          {dueRows.length} trains due inside 10 minutes
        </div>
      ) : null}
    </Card>
  );
}
