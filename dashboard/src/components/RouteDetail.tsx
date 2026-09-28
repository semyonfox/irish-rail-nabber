import type { MapRouteSelection } from "./TrainMap";
import { STATION_BOARD } from "../graphql/queries";
import { usePollingQuery } from "../utils/usePollingQuery";
import { formatTime, shortDelay } from "../utils/format";
import { DelayPill, Empty, MiniStat, Sheet } from "./ui";

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
  return value.replace("T", " ").slice(11, 16);
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
  return `${dueIn} min`;
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
    <Sheet
      label="route details"
      onClose={onClose}
      eyebrow="Route link"
      title={`${route.fromStationName} to ${route.toStationName}`}
      subtitle={
        <span className="inline-flex items-center gap-2">
          <span className="chip">{route.fromStationCode}</span>→
          <span className="chip">{route.toStationCode}</span>
        </span>
      }
    >
      <div className="grid grid-cols-2 gap-2">
        <MiniStat label="Recent trains" value={route.trainCount} />
        <MiniStat label="Last seen" value={formatLastSeen(route.lastSeen)} />
        <MiniStat label="Endpoint delays" value={delayed} tone={delayed > 0 ? "warn" : undefined} />
        <MiniStat label="Worst endpoint" value={shortDelay(worstDelay)} />
      </div>

      {severe > 0 ? (
        <div className="tone-block px-4 py-3 text-[14px] font-medium" data-tone="bad">
          {severe} severe endpoint {severe === 1 ? "delay" : "delays"} on this link
        </div>
      ) : null}

      <div>
        <div className="section-label">
          <span>Endpoint boards</span>
          {loading ? <span className="code">Updating…</span> : null}
        </div>
        {endpointRows.length === 0 && !loading ? (
          <Empty className="!min-h-24">
            No live endpoint board rows in the latest poll window.
          </Empty>
        ) : null}
        {endpointRows.slice(0, 10).map((event) => (
          <div
            key={`${event.endpointCode}-${event.trainCode}-${event.dueIn}-${event.lateMinutes}`}
            className="board-row"
          >
            <span className="board-time">{eventTime(event)}</span>
            <div className="min-w-0">
              <div className="truncate text-[14.5px] font-semibold">{event.endpointName}</div>
              <div className="truncate text-[12.5px] text-muted">
                <span className="code">{event.trainCode}</span> · {event.origin || "—"} →{" "}
                {event.destination || "—"} · Due {dueLabel(event.dueIn)}
              </div>
            </div>
            <DelayPill minutes={event.lateMinutes} />
          </div>
        ))}
      </div>
    </Sheet>
  );
}
