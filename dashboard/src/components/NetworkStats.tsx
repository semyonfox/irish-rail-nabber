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

  const cards = [
    { label: "Live trains", value: trains.length, tone: "text-white" },
    { label: "Late board", value: delayed, tone: "text-[var(--rail-orange)]" },
    { label: "Severe", value: severe, tone: "text-[var(--rail-red)]" },
    { label: "Stations", value: stations.length, tone: "text-white" },
  ];

  return (
    <div className="pointer-events-auto grid grid-cols-2 gap-2 md:flex md:gap-3">
      {cards.map((card) => (
        <div
          key={card.label}
          className="rounded-lg border border-[var(--rail-border)] bg-[var(--rail-surface)]/95 px-4 py-2 shadow-lg backdrop-blur"
        >
          <div className="text-xs text-[var(--rail-muted)]">{card.label}</div>
          <div className={`text-lg font-semibold ${card.tone}`}>{card.value}</div>
        </div>
      ))}
    </div>
  );
}
