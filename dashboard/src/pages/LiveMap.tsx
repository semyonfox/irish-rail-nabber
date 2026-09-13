import { useState } from "react";
import TrainMap, { type MapRouteSelection, type MapStationSelection } from "../components/TrainMap";
import NetworkStats, { type RailBoardEvent } from "../components/NetworkStats";
import TrainDetail from "../components/TrainDetail";
import StationDetail from "../components/StationDetail";
import RouteDetail from "../components/RouteDetail";
import { LIVE_RAIL_OVERVIEW, STATIONS } from "../graphql/queries";
import { usePollingQuery } from "../utils/usePollingQuery";
import type { LiveTrain, RailStation } from "../components/TrainMap";

interface LiveRailOverviewData {
  liveTrains: LiveTrain[];
  countryBoard: RailBoardEvent[];
}

interface StationsData {
  stations: RailStation[];
}

const LIVE_RAIL_POLL_MS = 15_000;

export default function LiveMap() {
  const [selectedTrain, setSelectedTrain] = useState<{
    trainCode: string;
    trainDate: string | null;
  } | null>(null);
  const [selectedStation, setSelectedStation] = useState<MapStationSelection | null>(null);
  const [selectedRoute, setSelectedRoute] = useState<MapRouteSelection | null>(null);

  const [{ data: liveData }] = usePollingQuery<LiveRailOverviewData>({
    query: LIVE_RAIL_OVERVIEW,
    variables: { boardLimit: 100, boardMinutes: 45 },
    pollInterval: LIVE_RAIL_POLL_MS,
  });
  const [{ data: stationsData }] = usePollingQuery<StationsData>({ query: STATIONS });

  const trains = liveData?.liveTrains ?? [];
  const stations = stationsData?.stations ?? [];
  const board = liveData?.countryBoard ?? [];

  const selectTrain = (trainCode: string) => {
    const trainDate = trains.find((train) => train.trainCode === trainCode)?.trainDate ?? null;
    setSelectedTrain({ trainCode, trainDate });
    setSelectedStation(null);
    setSelectedRoute(null);
  };

  const selectStation = (station: MapStationSelection) => {
    setSelectedStation(station);
    setSelectedTrain(null);
    setSelectedRoute(null);
  };

  const selectRoute = (route: MapRouteSelection) => {
    setSelectedRoute(route);
    setSelectedTrain(null);
    setSelectedStation(null);
  };

  const hasSheet = Boolean(selectedTrain || selectedStation || selectedRoute);

  return (
    <div className={`map-shell${hasSheet ? " has-sheet" : ""}`}>
      <TrainMap
        trains={trains}
        stations={stations}
        selectedTrainCode={selectedTrain?.trainCode}
        selectedTrainDate={selectedTrain?.trainDate}
        selectedStationCode={selectedStation?.stationCode}
        onTrainClick={selectTrain}
        onStationClick={selectStation}
        onRouteClick={selectRoute}
      />
      <div className="pointer-events-none absolute left-3 top-3 z-30 sm:left-4 sm:top-4">
        <NetworkStats trains={trains} stations={stations} board={board} />
      </div>
      {selectedTrain && (
        <TrainDetail
          trainCode={selectedTrain.trainCode}
          trainDate={selectedTrain.trainDate}
          onClose={() => setSelectedTrain(null)}
        />
      )}
      {selectedStation && (
        <StationDetail station={selectedStation} onClose={() => setSelectedStation(null)} />
      )}
      {selectedRoute && (
        <RouteDetail route={selectedRoute} onClose={() => setSelectedRoute(null)} />
      )}
    </div>
  );
}
