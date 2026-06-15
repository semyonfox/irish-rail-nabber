import type { MapRouteSelection } from "./TrainMap";
import { STATION_BOARD } from "../graphql/queries";
import { usePollingQuery } from "../utils/usePollingQuery";
import { delayColor, formatTime } from "../utils/format";

interface Props {
  route: MapRouteSelection;
  onClose: () => void;
}

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

function formatLastSeen(value: string | null) {
  if (!value) return "Unknown";
  return value.replace("T", " ").slice(0, 16);
}

function eventTime(event: StationEvent) {
  return formatTime(
    event.expectedDeparture ||
      event.expectedArrival ||
      event.scheduledDeparture ||
      event.scheduledArrival,
  );
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

export default function RouteDetail({ route, onClose }: Props) {
  const [{ data: fromData, fetching: fetchingFrom }] = usePollingQuery<StationBoardData>({
    query: STATION_BOARD,
    variables: { stationCode: route.fromStationCode, limit: 8 },
    pollInterval: 10000,
  });
  const [{ data: toData, fetching: fetchingTo }] = usePollingQuery<StationBoardData>({
    query: STATION_BOARD,
    variables: { stationCode: route.toStationCode, limit: 8 },
    pollInterval: 10000,
  });

  const endpointRows = [
    ...(fromData?.stationBoard ?? []).map((event) => ({
      ...event,
      endpointCode: route.fromStationCode,
      endpointName: route.fromStationName,
    })),
    ...(toData?.stationBoard ?? []).map((event) => ({
      ...event,
      endpointCode: route.toStationCode,
      endpointName: route.toStationName,
    })),
  ].sort((a, b) => {
    const delaySort = (b.lateMinutes ?? 0) - (a.lateMinutes ?? 0);
    if (delaySort !== 0) return delaySort;
    return (a.dueIn ?? 9999) - (b.dueIn ?? 9999);
  });
  const delayed = endpointRows.filter((event) => (event.lateMinutes ?? 0) >= 5).length;
  const severe = endpointRows.filter((event) => (event.lateMinutes ?? 0) >= 15).length;
  const worstDelay = endpointRows.reduce((max, event) => Math.max(max, event.lateMinutes ?? 0), 0);
  const loading = fetchingFrom || fetchingTo;

  return (
    <div className="fixed inset-y-0 right-0 z-50 w-full overflow-auto border-l border-[var(--rail-border)] bg-[var(--rail-surface)] p-4 shadow-xl sm:w-96">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase text-[var(--rail-green)]">Route link</p>
          <h2 className="text-lg font-bold text-white">
            {route.fromStationName} to {route.toStationName}
          </h2>
          <p className="text-sm text-[var(--rail-muted)]">
            {route.fromStationCode} {"->"} {route.toStationCode}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg px-2 py-1.5 text-sm text-[var(--rail-muted)] hover:bg-[var(--rail-bg)] hover:text-white"
          aria-label="Close route panel"
        >
          X
        </button>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-2 text-sm">
        <div className="rounded-lg border border-[var(--rail-border)] bg-[var(--rail-bg)]/70 p-3">
          <div className="text-xs text-[var(--rail-muted)]">Recent trains</div>
          <div className="text-xl font-semibold text-white">{route.trainCount}</div>
        </div>
        <div className="rounded-lg border border-[var(--rail-border)] bg-[var(--rail-bg)]/70 p-3">
          <div className="text-xs text-[var(--rail-muted)]">Last seen</div>
          <div className="text-sm font-medium text-white">{formatLastSeen(route.lastSeen)}</div>
        </div>
        <div className="rounded-lg border border-[var(--rail-border)] bg-[var(--rail-bg)]/70 p-3">
          <div className="text-xs text-[var(--rail-muted)]">Endpoint delays</div>
          <div className="text-xl font-semibold text-[var(--rail-orange)]">{delayed}</div>
        </div>
        <div className="rounded-lg border border-[var(--rail-border)] bg-[var(--rail-bg)]/70 p-3">
          <div className="text-xs text-[var(--rail-muted)]">Worst endpoint</div>
          <div className="text-xl font-semibold text-white">+{worstDelay}m</div>
        </div>
      </div>

      {severe > 0 && (
        <div className="mb-4 rounded-lg border border-red-500/50 bg-red-950/20 p-3 text-sm text-red-100">
          {severe} severe endpoint delays on this link
        </div>
      )}

      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white">Endpoint board</h3>
        {loading && <span className="text-xs text-[var(--rail-muted)]">Updating</span>}
      </div>

      <div className="space-y-2">
        {endpointRows.length === 0 && !loading && (
          <p className="rounded-lg border border-[var(--rail-border)] bg-[var(--rail-bg)]/70 p-3 text-sm text-[var(--rail-muted)]">
            No live endpoint board rows in the latest poll window.
          </p>
        )}
        {endpointRows.slice(0, 10).map((event) => (
          <div
            key={`${event.endpointCode}-${event.trainCode}-${event.dueIn}-${event.lateMinutes}`}
            className="rounded-lg border border-[var(--rail-border)] bg-[var(--rail-bg)]/70 p-3"
          >
            <div className="mb-1 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-white">
                  {event.trainCode} · {event.endpointName}
                </div>
                <div className="truncate text-xs text-[var(--rail-muted)]">
                  {event.origin || "-"} to {event.destination || "-"}
                </div>
              </div>
              <span
                className="shrink-0 text-xs font-semibold"
                style={{ color: delayColor(event.lateMinutes) }}
              >
                {delayLabel(event.lateMinutes)}
              </span>
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-[var(--rail-muted)]">
              <span>{eventTime(event)}</span>
              <span>Due {dueLabel(event.dueIn)}</span>
              {event.lastLocation && <span>{event.lastLocation}</span>}
              {event.status && <span>{event.status}</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
