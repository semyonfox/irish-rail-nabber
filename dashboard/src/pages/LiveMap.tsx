import LiveMapShell from "../components/LiveMapShell";
import { useState } from "react";
import TrainMap, { type MapRouteSelection, type MapStationSelection } from "../components/TrainMap";
import NetworkStats, { type RailBoardEvent } from "../components/NetworkStats";
import TrainDetail from "../components/TrainDetail";
import StationDetail from "../components/StationDetail";
import RouteDetail from "../components/RouteDetail";
import { LIVE_RAIL_OVERVIEW, STATIONS } from "../graphql/queries";
import { usePollingQuery } from "../utils/usePollingQuery";
import type { LiveTrain, RailStation } from "../components/TrainMap";
import RequestError from "../components/RequestError";
import { Empty, SearchInput, Segmented } from "../components/ui";

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
  const [selectedStation, setSelectedStation] = useState<RailStation | null>(null);
  const [selectedRoute, setSelectedRoute] = useState<MapRouteSelection | null>(null);
  const [search, setSearch] = useState("");
  const [listMode, setListMode] = useState<"trains" | "stations">("trains");

  const [{ data: liveData, fetching: liveFetching, error: liveError }, retryLive] =
    usePollingQuery<LiveRailOverviewData>({
      query: LIVE_RAIL_OVERVIEW,
      variables: { boardLimit: 100, boardMinutes: 45 },
      pollInterval: LIVE_RAIL_POLL_MS,
    });
  const [{ data: stationsData, fetching: stationsFetching, error: stationsError }, retryStations] =
    usePollingQuery<StationsData>({ query: STATIONS });

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
  const needle = search.trim().toLowerCase();
  const filteredTrains = trains.filter((train) =>
    [train.trainCode, train.direction, train.trainType].some((value) =>
      value?.toLowerCase().includes(needle),
    ),
  );
  const filteredStations = stations.filter((station) =>
    `${station.stationDesc} ${station.stationCode}`.toLowerCase().includes(needle),
  );

  return (
    <LiveMapShell
      title="Live rail services"
      hasSheet={hasSheet}
      map={
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
      }
      summary={
        <NetworkStats
          trains={trains}
          stations={stations}
          board={board}
          known={Boolean(liveData)}
          stationsKnown={Boolean(stationsData)}
          live={Boolean(liveData) && !liveError}
          status={
            liveError
              ? "Updates unavailable"
              : !liveData
                ? "Checking rail feed"
                : "Latest rail feed"
          }
        >
          <p className="mt-3 text-sm text-ink-2">
            Choose a service or station below to open its board. No account needed.
          </p>
          {liveError ? (
            <RequestError
              bare
              error={liveError}
              title={liveData ? "Showing last loaded rail data" : "Rail data unavailable"}
              onRetry={() => retryLive({ requestPolicy: "network-only" })}
            />
          ) : null}
          {stationsError ? (
            <RequestError
              bare
              error={stationsError}
              title="Stations unavailable"
              onRetry={() => retryStations({ requestPolicy: "network-only" })}
            />
          ) : null}
          <details className="rail-selector" open>
            <summary>Find trains and stations</summary>
            <Segmented
              label="Rail list"
              options={[
                { value: "trains", label: "Trains" },
                { value: "stations", label: "Stations" },
              ]}
              value={listMode}
              onChange={setListMode}
            />
            <SearchInput
              value={search}
              onChange={setSearch}
              label="Find rail services or stations"
              placeholder="Name, train or station code"
            />
            <p className="text-xs text-muted" role="status">
              {listMode === "trains"
                ? !liveData && liveFetching
                  ? "Loading trains…"
                  : `${filteredTrains.length} trains shown`
                : !stationsData && stationsFetching
                  ? "Loading stations…"
                  : `${filteredStations.length} stations shown`}
            </p>
            <div
              className="rail-selector-list"
              aria-label={listMode === "trains" ? "Rail services" : "Rail stations"}
            >
              {listMode === "trains"
                ? filteredTrains.map((train) => (
                    <button
                      type="button"
                      key={`${train.trainCode}-${train.trainDate}`}
                      className="rail-option"
                      aria-pressed={selectedTrain?.trainCode === train.trainCode}
                      onClick={() => selectTrain(train.trainCode)}
                    >
                      <strong>{train.trainCode}</strong>
                      <span>{train.direction || train.trainType || "Route unavailable"}</span>
                      {train.latitude == null || train.longitude == null ? (
                        <small>Map position unavailable</small>
                      ) : null}
                    </button>
                  ))
                : filteredStations.map((station) => (
                    <button
                      type="button"
                      key={station.stationCode}
                      className="rail-option"
                      aria-pressed={selectedStation?.stationCode === station.stationCode}
                      onClick={() => {
                        setSelectedStation(station);
                        setSelectedTrain(null);
                        setSelectedRoute(null);
                      }}
                    >
                      <strong>{station.stationDesc}</strong>
                      <span>{station.stationCode}</span>
                    </button>
                  ))}
            </div>
            {listMode === "trains" && liveData && filteredTrains.length === 0 && !liveError ? (
              <Empty className="!min-h-16">
                {needle
                  ? "No trains match. Try a different search."
                  : "No services in the latest rail feed."}
              </Empty>
            ) : null}
            {listMode === "stations" &&
            stationsData &&
            filteredStations.length === 0 &&
            !stationsError ? (
              <Empty className="!min-h-16">No stations match. Try a different search.</Empty>
            ) : null}
          </details>
        </NetworkStats>
      }
    >
      {selectedTrain && (
        <TrainDetail
          key={`${selectedTrain.trainCode}-${selectedTrain.trainDate}`}
          trainCode={selectedTrain.trainCode}
          trainDate={selectedTrain.trainDate}
          onClose={() => setSelectedTrain(null)}
        />
      )}
      {selectedStation && (
        <StationDetail
          key={selectedStation.stationCode}
          station={selectedStation}
          onClose={() => setSelectedStation(null)}
        />
      )}
      {selectedRoute && (
        <RouteDetail route={selectedRoute} onClose={() => setSelectedRoute(null)} />
      )}
    </LiveMapShell>
  );
}
