import { lazy, Suspense, useState } from "react";
import type { MapRouteSelection, MapStationSelection } from "../components/TrainMap";
import NetworkStats from "../components/NetworkStats";
import TrainDetail from "../components/TrainDetail";
import StationDetail from "../components/StationDetail";
import RouteDetail from "../components/RouteDetail";

const TrainMap = lazy(() => import("../components/TrainMap"));
const CountryBoard = lazy(() => import("../components/CountryBoard"));

function MapFallback() {
  return (
    <div className="flex h-full items-center justify-center bg-slate-950 text-sm text-slate-300">
      Loading live map…
    </div>
  );
}

function PanelFallback() {
  return (
    <div className="rounded-2xl bg-white/90 px-4 py-3 text-sm text-slate-500 shadow-lg ring-1 ring-slate-200">
      Loading departures…
    </div>
  );
}

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

  const hasSelection = selectedTrain || selectedStation || selectedRoute;

  return (
    <div className="relative h-full">
      <Suspense fallback={<MapFallback />}>
        <TrainMap
          selectedTrainCode={selectedTrain}
          selectedStationCode={selectedStation?.stationCode}
          onTrainClick={selectTrain}
          onStationClick={selectStation}
          onRouteClick={selectRoute}
        />
      </Suspense>
      <div className="pointer-events-none absolute left-4 top-4">
        <NetworkStats />
      </div>
      {!hasSelection && (
        <div className="pointer-events-auto absolute right-4 top-4 z-40 hidden max-h-[calc(100%-2rem)] w-[460px] overflow-auto xl:block">
          <Suspense fallback={<PanelFallback />}>
            <CountryBoard compact limit={45} minutes={45} />
          </Suspense>
        </div>
      )}
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
  );
}
