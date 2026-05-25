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

export default function StationDetail({ station, onClose }: Props) {
  const [{ data, fetching }] = usePollingQuery<StationBoardData>({
    query: STATION_BOARD,
    variables: { stationCode: station.stationCode, limit: 12 },
    pollInterval: 10000,
  });

  const board = data?.stationBoard ?? [];

  return (
    <div className="fixed inset-y-0 right-0 z-50 w-full overflow-auto border-l border-[var(--rail-border)] bg-[var(--rail-surface)] p-4 shadow-xl sm:w-96">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--rail-green)]">
            {station.stationCode}
          </p>
          <h2 className="text-lg font-bold text-white">{station.stationDesc}</h2>
          <p className="text-sm text-[var(--rail-muted)]">{stationTypeLabel(station)}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg px-2 py-1.5 text-sm text-[var(--rail-muted)] hover:bg-[var(--rail-bg)] hover:text-white"
          aria-label="Close station panel"
        >
          X
        </button>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-2 text-sm">
        <div className="rounded-lg border border-[var(--rail-border)] bg-[var(--rail-bg)]/70 p-3">
          <div className="text-xs text-[var(--rail-muted)]">Latitude</div>
          <div className="font-medium text-white">{station.latitude.toFixed(4)}</div>
        </div>
        <div className="rounded-lg border border-[var(--rail-border)] bg-[var(--rail-bg)]/70 p-3">
          <div className="text-xs text-[var(--rail-muted)]">Longitude</div>
          <div className="font-medium text-white">{station.longitude.toFixed(4)}</div>
        </div>
      </div>

      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white">Live board</h3>
        {fetching && <span className="text-xs text-[var(--rail-muted)]">Updating</span>}
      </div>

      <div className="space-y-2">
        {board.length === 0 && !fetching && (
          <p className="rounded-lg border border-[var(--rail-border)] bg-[var(--rail-bg)]/70 p-3 text-sm text-[var(--rail-muted)]">
            No live board rows in the latest poll window.
          </p>
        )}
        {board.map((event) => {
          const scheduled = event.scheduledArrival || event.scheduledDeparture;
          const expected = event.expectedArrival || event.expectedDeparture;
          const delay = event.lateMinutes;

          return (
            <div
              key={`${event.trainCode}-${scheduled}-${expected}`}
              className="rounded-lg border border-[var(--rail-border)] bg-[var(--rail-bg)]/70 p-3"
            >
              <div className="mb-1 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-white">
                    {event.trainCode}
                  </div>
                  <div className="truncate text-xs text-[var(--rail-muted)]">
                    {event.origin || "-"} to {event.destination || "-"}
                  </div>
                </div>
                <span
                  className="shrink-0 text-xs font-semibold"
                  style={{ color: delayColor(delay) }}
                >
                  {delay == null ? "N/A" : delay <= 0 ? "On time" : `+${delay}m`}
                </span>
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-[var(--rail-muted)]">
                <span>Sched {formatTime(scheduled)}</span>
                {expected && <span>Exp {formatTime(expected)}</span>}
                {event.dueIn != null && <span>Due {event.dueIn}m</span>}
                {event.lastLocation && <span>{event.lastLocation}</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
