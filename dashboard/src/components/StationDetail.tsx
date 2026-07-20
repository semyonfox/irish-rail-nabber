import { STATION_BOARD } from "../graphql/queries";
import { usePollingQuery } from "../utils/usePollingQuery";
import { delayColor, formatTime } from "../utils/format";
import type { MapStationSelection } from "./TrainMap";

interface StationEvent {
  trainCode: string;
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
  dueIn: number | null;
  lastLocation: string | null;
}

interface StationBoardData {
  stationBoard: StationEvent[];
}

interface Props {
  station: MapStationSelection;
  onClose: () => void;
}

function stationTypeLabel(station: MapStationSelection) {
  if (station.isDart) return "DART";
  if (station.stationType === "M") return "Mainline";
  if (station.stationType === "S") return "Suburban";
  if (station.stationType === "A") return "Airport";
  return "Rail station";
}

function isRealTime(time: string | null | undefined) {
  return Boolean(time && time !== "00:00:00");
}

function pickTime(...times: (string | null | undefined)[]) {
  return times.find(isRealTime) ?? null;
}

function eventKind(event: StationEvent) {
  if (pickTime(event.expectedDeparture, event.scheduledDeparture)) return "Dep";
  if (pickTime(event.expectedArrival, event.scheduledArrival)) return "Arr";
  return "-";
}

function eventTime(event: StationEvent) {
  const time =
    eventKind(event) === "Dep"
      ? pickTime(event.expectedDeparture, event.scheduledDeparture)
      : pickTime(event.expectedArrival, event.scheduledArrival);
  return formatTime(time);
}

function dueLabel(dueIn: number | null) {
  if (dueIn == null) return "-";
  if (dueIn < 0) return "Left";
  if (dueIn === 0) return "Due";
  return `${dueIn}m`;
}

function delayLabel(delay: number | null) {
  if (delay == null) return "N/A";
  if (delay <= 0) return "RT";
  return `+${delay}m`;
}

export default function StationDetail({ station, onClose }: Props) {
  const [{ data, fetching }] = usePollingQuery<StationBoardData>({
    query: STATION_BOARD,
    variables: { stationCode: station.stationCode, limit: 18 },
    pollInterval: 10000,
  });

  const board = data?.stationBoard ?? [];
  const sortedBoard = [...board].sort((a, b) => {
    const pressure = (b.lateMinutes ?? 0) - (a.lateMinutes ?? 0);
    if (pressure !== 0) return pressure;
    return (a.dueIn ?? 9999) - (b.dueIn ?? 9999);
  });
  const delayed = board.filter((event) => (event.lateMinutes ?? 0) >= 5);
  const severe = board.filter((event) => (event.lateMinutes ?? 0) >= 15);
  const dueSoon = board.filter(
    (event) => event.dueIn != null && event.dueIn >= 0 && event.dueIn <= 10,
  );
  const nextEvent = [...board]
    .filter((event) => event.dueIn != null && event.dueIn >= -1)
    .sort((a, b) => (a.dueIn ?? 9999) - (b.dueIn ?? 9999))[0];
  const worstDelay = board.reduce((max, event) => Math.max(max, event.lateMinutes ?? 0), 0);

  return (
    <div className="fixed inset-y-0 right-0 z-50 w-full overflow-auto border-l border-[var(--rail-border)] bg-[var(--rail-surface)] p-4 shadow-xl sm:w-96">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase text-[var(--rail-green)]">
            {station.stationCode}
          </p>
          <h2 className="text-lg font-bold text-white">{station.stationDesc}</h2>
          <p className="text-sm text-[var(--rail-muted)]">
            {stationTypeLabel(station)} · {board.length} current board rows
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="px-2 py-1.5 text-sm text-[var(--rail-muted)] hover:bg-[var(--rail-bg)] hover:text-white"
          aria-label="Close station panel"
        >
          X
        </button>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-2 text-sm">
        <div className="border border-[var(--rail-border)] bg-[var(--rail-bg)]/70 p-3">
          <div className="text-xs text-[var(--rail-muted)]">Due inside 10m</div>
          <div className="text-xl font-semibold text-white">{dueSoon.length}</div>
        </div>
        <div className="border border-[var(--rail-border)] bg-[var(--rail-bg)]/70 p-3">
          <div className="text-xs text-[var(--rail-muted)]">Delayed</div>
          <div className="text-xl font-semibold text-[var(--rail-warn)]">{delayed.length}</div>
        </div>
        <div className="border border-[var(--rail-border)] bg-[var(--rail-bg)]/70 p-3">
          <div className="text-xs text-[var(--rail-muted)]">Severe</div>
          <div className="text-xl font-semibold text-[var(--rail-red)]">{severe.length}</div>
        </div>
        <div className="border border-[var(--rail-border)] bg-[var(--rail-bg)]/70 p-3">
          <div className="text-xs text-[var(--rail-muted)]">Worst delay</div>
          <div className="text-xl font-semibold text-white">+{worstDelay}m</div>
        </div>
      </div>

      {nextEvent && (
        <div className="mb-4 border border-[var(--rail-border)] bg-[var(--rail-bg)]/70 p-3">
          <div className="mb-1 text-xs uppercase text-[var(--rail-muted)]">Next movement</div>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-white">
                {nextEvent.trainCode} · {eventKind(nextEvent)} {eventTime(nextEvent)}
              </div>
              <div className="truncate text-xs text-[var(--rail-muted)]">
                {nextEvent.origin || "-"} to {nextEvent.destination || "-"}
              </div>
            </div>
            <div className="shrink-0 text-right">
              <div className="text-sm font-semibold text-white">{dueLabel(nextEvent.dueIn)}</div>
              <div className="text-xs" style={{ color: delayColor(nextEvent.lateMinutes) }}>
                {delayLabel(nextEvent.lateMinutes)}
              </div>
            </div>
          </div>
          {nextEvent.lastLocation && (
            <div className="mt-2 truncate text-xs text-[var(--rail-muted)]">
              {nextEvent.lastLocation}
            </div>
          )}
        </div>
      )}

      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white">Live board</h3>
        {fetching && <span className="text-xs text-[var(--rail-muted)]">Updating</span>}
      </div>

      <div className="space-y-2">
        {board.length === 0 && !fetching && (
          <p className="border border-[var(--rail-border)] bg-[var(--rail-bg)]/70 p-3 text-sm text-[var(--rail-muted)]">
            No live board rows in the latest poll window.
          </p>
        )}
        {sortedBoard.map((event) => {
          const scheduled = event.scheduledArrival || event.scheduledDeparture;
          const expected = event.expectedArrival || event.expectedDeparture;
          const delay = event.lateMinutes;

          return (
            <div
              key={`${event.trainCode}-${scheduled}-${expected}`}
              className="border border-[var(--rail-border)] bg-[var(--rail-bg)]/70 p-3 hover:border-[var(--rail-border-strong)]"
            >
              <div className="mb-1 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-white">
                    {event.trainCode} · {eventKind(event)} {eventTime(event)}
                  </div>
                  <div className="truncate text-xs text-[var(--rail-muted)]">
                    {event.origin || "-"} to {event.destination || "-"}
                  </div>
                </div>
                <span
                  className="shrink-0 text-xs font-semibold"
                  style={{ color: delayColor(delay) }}
                >
                  {delayLabel(delay)}
                </span>
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-[var(--rail-muted)]">
                <span>Sched {formatTime(scheduled)}</span>
                {expected && <span>Exp {formatTime(expected)}</span>}
                {event.dueIn != null && <span>Due {dueLabel(event.dueIn)}</span>}
                {event.lastLocation && <span>{event.lastLocation}</span>}
                {event.status && <span>{event.status}</span>}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-4 text-xs text-[var(--rail-muted)]">
        {station.latitude.toFixed(4)}, {station.longitude.toFixed(4)}
      </div>
    </div>
  );
}
