import { useState } from "react";
import TrainMap, { type MapRouteSelection, type MapStationSelection } from "../components/TrainMap";
import NetworkStats from "../components/NetworkStats";
import TrainDetail from "../components/TrainDetail";
import StationDetail from "../components/StationDetail";
import RouteDetail from "../components/RouteDetail";

export default function LiveMap() {
  const [selectedTrain, setSelectedTrain] = useState<string | null>(null);
  const [selectedStation, setSelectedStation] = useState<MapStationSelection | null>(null);
  const [selectedRoute, setSelectedRoute] = useState<MapRouteSelection | null>(null);

  const selectTrain = (trainCode: string) => {
    setSelectedTrain(trainCode);
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

  return (
    <div className="operations-workspace h-full">
      <div className="workspace-label">
        <span className="workspace-index">01</span>
        <span>
          <strong>Network movement</strong>
          <small>Live geographic overview</small>
        </span>
        <span className="workspace-live">
          <i /> LIVE
        </span>
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden border border-[var(--rail-border)] bg-[var(--rail-surface)]">
        <TrainMap
          selectedTrainCode={selectedTrain}
          selectedStationCode={selectedStation?.stationCode}
          onTrainClick={selectTrain}
          onStationClick={selectStation}
          onRouteClick={selectRoute}
        />
        <div className="pointer-events-none absolute left-3 top-3 z-30">
          <NetworkStats />
        </div>
        {selectedTrain && (
          <TrainDetail trainCode={selectedTrain} onClose={() => setSelectedTrain(null)} />
        )}
        {selectedStation && (
          <StationDetail station={selectedStation} onClose={() => setSelectedStation(null)} />
        )}
        {selectedRoute && (
          <RouteDetail route={selectedRoute} onClose={() => setSelectedRoute(null)} />
        )}
      </div>
    </div>
  );
}
