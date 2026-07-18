import { COUNTRY_BOARD, LIVE_TRAINS, STATIONS } from "../graphql/queries";
import { usePollingQuery } from "../utils/usePollingQuery";

interface Train {
  trainCode: string;
}

interface Station {
  stationCode: string;
}

interface BoardEvent {
  lateMinutes: number | null;
}

interface TrainsData {
  liveTrains: Train[];
}

interface StationsData {
  stations: Station[];
}

interface CountryBoardData {
  countryBoard: BoardEvent[];
}

export default function NetworkStats() {
  const [{ data: trainsData }] = usePollingQuery<TrainsData>({
    query: LIVE_TRAINS,
    pollInterval: 10000,
  });
  const [{ data: stationsData }] = usePollingQuery<StationsData>({
    query: STATIONS,
  });
  const [{ data: boardData }] = usePollingQuery<CountryBoardData>({
    query: COUNTRY_BOARD,
    variables: { limit: 100, minutes: 45 },
    pollInterval: 15000,
  });

  const trains = trainsData?.liveTrains ?? [];
  const stations = stationsData?.stations ?? [];
  const board = boardData?.countryBoard ?? [];
  const delayed = board.filter((row) => (row.lateMinutes ?? 0) >= 5).length;
  const severe = board.filter((row) => (row.lateMinutes ?? 0) >= 15).length;

  const stats = [
    { label: "Live trains", value: trains.length, tone: "text-white" },
    { label: "Delayed", value: delayed, tone: "text-[var(--rail-orange)]" },
    { label: "Severe", value: severe, tone: "text-[var(--rail-red)]" },
    { label: "Control points", value: stations.length, tone: "text-white" },
  ];

  return (
    <div className="network-readout pointer-events-auto" aria-label="Live network summary">
      {stats.map((stat) => (
        <div key={stat.label} className="network-readout-item">
          <span className={`network-readout-value ${stat.tone}`}>{stat.value}</span>
          <span className="network-readout-label">{stat.label}</span>
        </div>
      ))}
    </div>
  );
}
