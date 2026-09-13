import type { LiveTrain, RailStation } from "./TrainMap";
import LiveNetworkSummary from "./LiveNetworkSummary";

export interface RailBoardEvent {
  lateMinutes: number | null;
}

interface Props {
  trains: LiveTrain[];
  stations: RailStation[];
  board: RailBoardEvent[];
}

export default function NetworkStats({ trains, stations, board }: Props) {
  const mapped = trains.filter((train) => train.latitude != null && train.longitude != null);
  const unavailable = trains.filter((train) => train.latitude == null || train.longitude == null);
  const delayed = board.filter((row) => (row.lateMinutes ?? 0) >= 5).length;
  const severe = board.filter((row) => (row.lateMinutes ?? 0) >= 15).length;

  return (
    <LiveNetworkSummary
      status="Live now"
      live
      count={trains.length}
      caption="services in live feed"
      detail={`${mapped.length}/${trains.length} on map`}
      stats={[
        {
          label: "Late",
          value: delayed,
          tone: delayed > 0 ? "warn" : undefined,
          title: "Services 5+ minutes late on boards over the next 45 minutes",
        },
        {
          label: "Severe",
          value: severe,
          tone: severe > 0 ? "bad" : undefined,
          title: "Services 15+ minutes late on boards over the next 45 minutes",
        },
        { label: "Stations", value: stations.length },
      ]}
    >
      {unavailable.length > 0 ? (
        <details className="mt-3 border-t border-line pt-3 text-[12.5px]">
          <summary className="cursor-pointer text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">
            {unavailable.length} position{unavailable.length === 1 ? "" : "s"} unavailable
          </summary>
          <ul
            className="mt-2 max-h-32 space-y-1.5 overflow-y-auto pr-1"
            aria-label="Services without a live map position"
          >
            {unavailable.map((train) => (
              <li key={train.trainCode} className="flex items-baseline justify-between gap-3">
                <span className="code text-ink">{train.trainCode}</span>
                <span className="truncate text-right text-muted">
                  {train.direction || train.trainType || "Location not reported"}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <div className="mt-4 hidden flex-wrap gap-x-4 gap-y-1.5 border-t border-line pt-3 text-[12.5px] text-muted sm:flex">
        <span className="legend">
          <i className="legend-train" />
          Train
        </span>
        <span className="legend">
          <i className="legend-station" />
          Station
        </span>
        <span className="legend">
          <i className="legend-track" />
          Track
        </span>
        <span className="legend">
          <i className="legend-route" />
          Selected route
        </span>
      </div>
    </LiveNetworkSummary>
  );
}
