import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import LiveMapShell from "../components/LiveMapShell";
import LiveNetworkSummary from "../components/LiveNetworkSummary";
import BusAttribution from "../components/BusAttribution";
import BusVehicleMap from "../components/BusVehicleMap";
import RequestError from "../components/RequestError";
import { Card, DelayPill, Empty, Icon, PageHeader, SearchInput, Segmented } from "../components/ui";
import {
  BUS_LIVE_CONDITIONS,
  BUS_LIVE_OVERVIEW,
  BUS_SCHEDULED_ROUTE_SHAPES,
  BUS_STOPS,
} from "../graphql/queries";
import { noticeCategoryLabel, type BusBunch, type BusServiceNotice } from "../utils/busConditions";
import {
  busFeedState,
  busSourceStatus,
  busUpdateAge,
  type BusRealtimeStatus,
} from "../utils/busRealtime";
import { busRoutePath } from "../utils/busHistory";
import type { BusRouteShape } from "../utils/busShapes";
import { busVehicleKey, busVehicleRoute, type BusVehicle } from "../utils/busVehicles";
import { usePollingQuery } from "../utils/usePollingQuery";

interface BusStop {
  stopId: string;
  stopCode: string | null;
  stopName: string | null;
  latitude: number | null;
  longitude: number | null;
}

interface BusDeparture {
  entityId: string | null;
  tripId: string | null;
  routeId: string | null;
  routeShortName: string | null;
  routeLongName: string | null;
  operatorName: string | null;
  headsign: string | null;
  serviceDate: string | null;
  scheduledTime: string | null;
  expectedTime: string | null;
  delaySeconds: number | null;
  scheduleRelationship: string | null;
  fetchedAt: string;
}

interface BusRouteDelay {
  feedVersionId: number;
  routeId: string;
  routeShortName: string | null;
  routeLongName: string | null;
  operatorName: string | null;
  avgDelaySeconds: number;
  onTimePct: number;
  sampleCount: number;
  lastUpdated: string | null;
}

interface BusStopsData {
  busStops: BusStop[];
}

interface BusLiveOverviewData {
  busRealtimeStatus: BusRealtimeStatus;
  busStopBoard?: BusDeparture[];
  busVehicles?: BusVehicle[];
  busLiveRouteShapes?: BusRouteShape[];
  busRouteDelays?: BusRouteDelay[];
}

interface BusLiveConditionsData {
  busServiceNotices: BusServiceNotice[];
  busBunching: BusBunch[];
}

// every shape a live bus is using. the API sends simplified polylines, about
// 400 KB for the whole network
const LIVE_SHAPE_LIMIT = 2_000;

interface BusScheduledRouteShapesData {
  busScheduledRouteShapes: BusRouteShape[];
}

const timeFormat = new Intl.DateTimeFormat("en-IE", {
  timeZone: "Europe/Dublin",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const hoursOptions = [
  { value: 6, label: "6 hours" },
  { value: 24, label: "24 hours" },
  { value: 72, label: "3 days" },
];

function timeLabel(value: string | null) {
  if (!value) return "--:--";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "--:--" : timeFormat.format(date);
}

const noticeDateFormat = new Intl.DateTimeFormat("en-IE", {
  timeZone: "Europe/Dublin",
  weekday: "short",
  day: "numeric",
  month: "short",
});

function noticeDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "a date not given" : noticeDateFormat.format(date);
}

function routeLabel(routeShortName: string | null, routeId: string | null) {
  return routeShortName?.trim() || routeId?.trim() || "Bus";
}

function stopMeta(stop: BusStop) {
  if (stop.stopCode) return `Stop ${stop.stopCode}`;
  if (stop.latitude != null && stop.longitude != null) {
    return `${stop.latitude.toFixed(4)}, ${stop.longitude.toFixed(4)}`;
  }
  return "NTA stop";
}

function stopName(stop: BusStop) {
  return stop.stopName?.trim() || stop.stopCode?.trim() || stop.stopId;
}

export default function Buses({ view = "live" }: { view?: "live" | "stops" | "network" }) {
  const [search, setSearch] = useState("");
  const [settledSearch, setSettledSearch] = useState("");
  const [selectedStop, setSelectedStop] = useState<BusStop | null>(null);
  const selectedStopId = selectedStop?.stopId ?? null;
  const changeStopRef = useRef<HTMLButtonElement>(null);
  const lastStopRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (window.matchMedia("(max-width: 639px)").matches) {
      const target = selectedStopId ? changeStopRef.current : lastStopRef.current;
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [selectedStopId]);
  const [hours, setHours] = useState(24);
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  const [routeSearch, setRouteSearch] = useState("");
  const [vehicleSearch, setVehicleSearch] = useState("");
  const [selectedVehicleKey, setSelectedVehicleKey] = useState<string | null>(null);
  // the page component is shared by every bus view, so drop the selection when
  // the view changes rather than reopening it on return
  const [selectionView, setSelectionView] = useState(view);
  if (selectionView !== view) {
    setSelectionView(view);
    setSelectedVehicleKey(null);
  }
  const expectedHours = view === "network" ? hours : 24;

  useEffect(() => {
    const id = setTimeout(() => setSettledSearch(search.trim()), 250);
    return () => clearTimeout(id);
  }, [search]);

  const [{ data: stopsData, fetching: stopsFetching, error: stopsError }, retryStops] =
    usePollingQuery<BusStopsData>({
      query: BUS_STOPS,
      pause: view !== "stops",
      variables: { search: settledSearch || null, limit: 60 },
    });

  const [
    { data: scheduledShapesData, fetching: scheduledShapesFetching, error: scheduledShapesError },
    retryScheduledShapes,
  ] = usePollingQuery<BusScheduledRouteShapesData>({
    query: BUS_SCHEDULED_ROUTE_SHAPES,
    pause: view !== "live",
    variables: { stopId: selectedStopId, limit: 24 },
  });

  const [liveResult, retryLive] = usePollingQuery<BusLiveOverviewData>({
    query: BUS_LIVE_OVERVIEW,
    variables: {
      stopId: selectedStopId ?? "",
      includeBoard: view === "stops" && selectedStopId != null,
      includeVehicles: view === "live",
      includeShapes: false,
      includeDelays: view === "network",
      boardLimit: 30,
      vehicleLimit: 2_000,
      shapeLimit: LIVE_SHAPE_LIMIT,
      hours: expectedHours,
      routeLimit: 100,
    },
    pollInterval: view === "network" ? 60_000 : 15_000,
  });
  const { data: liveData, fetching: liveFetching, error: liveError } = liveResult;

  // Geometry can be large and slow. It must not hold up positions or stop boards.
  const [{ data: shapesData, fetching: liveShapesFetching, error: liveShapesError }, retryShapes] =
    usePollingQuery<BusLiveOverviewData>({
      query: BUS_LIVE_OVERVIEW,
      pause: view !== "live",
      variables: {
        stopId: "",
        includeBoard: false,
        includeVehicles: false,
        includeShapes: true,
        includeDelays: false,
        shapeLimit: LIVE_SHAPE_LIMIT,
      },
      // lines only change as trips start, so this is slower than positions
      pollInterval: 120_000,
    });

  const [{ data: conditionsData }] = usePollingQuery<BusLiveConditionsData>({
    query: BUS_LIVE_CONDITIONS,
    pause: view !== "live",
    pollInterval: 30_000,
  });
  const notices = useMemo(() => conditionsData?.busServiceNotices ?? [], [conditionsData]);
  const bunches = useMemo(() => conditionsData?.busBunching ?? [], [conditionsData]);

  const boardResultIsCurrent =
    selectedStopId != null && liveResult.operation?.variables?.stopId === selectedStopId;
  const boardHasCurrentData = boardResultIsCurrent && liveData?.busStopBoard != null;
  const boardLoading =
    selectedStopId != null && !boardHasCurrentData && !(boardResultIsCurrent && liveError);
  const departures = boardHasCurrentData ? (liveData.busStopBoard ?? []) : [];
  const realtimeStatus = liveData?.busRealtimeStatus ?? null;
  const sourceStatus = busSourceStatus(
    realtimeStatus,
    view === "live" ? "vehicles" : "tripUpdates",
    now,
  );
  const feedState = busFeedState(sourceStatus, liveFetching && !liveData);
  const vehicles = liveData?.busVehicles ?? [];
  const liveRouteShapes = shapesData?.busLiveRouteShapes ?? [];
  const scheduledRouteShapes = scheduledShapesData?.busScheduledRouteShapes ?? [];
  const useLiveRouteShapes = feedState.isLive && liveRouteShapes.length > 0;
  const routeShapes = useLiveRouteShapes ? liveRouteShapes : scheduledRouteShapes;
  const routes =
    liveResult.operation?.variables?.hours === expectedHours
      ? (liveData?.busRouteDelays ?? [])
      : [];
  const routeNeedle = routeSearch.trim().toLowerCase();
  const shownRoutes = routes.filter((route) =>
    `${routeLabel(route.routeShortName, route.routeId)} ${route.routeId} ${route.routeLongName ?? ""} ${route.operatorName ?? ""}`
      .toLowerCase()
      .includes(routeNeedle),
  );

  if (view === "live") {
    const liveVehicles = feedState.isLive ? vehicles : [];
    const needle = vehicleSearch.trim().toLowerCase();
    const matchingVehicles = liveVehicles.filter((vehicle) =>
      [
        busVehicleRoute(vehicle),
        vehicle.headsign,
        vehicle.routeLongName,
        // the details sheet falls back to the id, so search must too
        vehicle.vehicleLabel || vehicle.vehicleId,
      ].some((value) => value?.toLowerCase().includes(needle)),
    );
    return (
      <LiveMapShell
        title="Live bus services"
        map={
          <BusVehicleMap
            vehicles={liveVehicles}
            routeShapes={routeShapes}
            realtimeStatus={sourceStatus}
            fetching={liveFetching}
            shapesFetching={scheduledShapesFetching || liveShapesFetching}
            shapeMode={useLiveRouteShapes ? "live" : "scheduled"}
            shapeFocusKey={selectedStopId ?? "network"}
            selectedKey={selectedVehicleKey}
            onSelect={setSelectedVehicleKey}
            bunches={bunches}
            notices={notices}
          />
        }
        summary={
          <LiveNetworkSummary
            status={liveError ? "Updates unavailable" : feedState.badge}
            live={feedState.isLive && !liveError}
            count={feedState.isLive ? vehicles.length : "--"}
            caption={vehicles.length === 1 ? "bus running" : "buses running"}
            detail={`${feedState.isLive ? vehicles.length : 0} on the map`}
            stats={[
              {
                label: "Routes",
                value: new Set(routeShapes.map((shape) => shape.routeId)).size,
                title: useLiveRouteShapes
                  ? "Routes with a bus running now"
                  : "Busiest scheduled routes, not the entire network",
              },
              {
                label: "Bunched",
                value: feedState.isLive ? bunches.length : "--",
                tone: bunches.length > 0 ? "warn" : undefined,
                title:
                  "Groups of buses on one route running together although the timetable spaces them at least six minutes apart",
              },
              { label: "Notices", value: notices.length, title: "NTA bus notices in effect now" },
            ]}
          >
            {liveVehicles.length > 0 && (
              <details className="map-selector">
                <summary>Find a live bus</summary>
                <SearchInput
                  value={vehicleSearch}
                  onChange={setVehicleSearch}
                  label="Find a live bus"
                  placeholder="Route, destination or fleet"
                />
                {/* only announce counts the rider asked for, not every poll */}
                <p className="text-xs text-muted" role={needle ? "status" : undefined}>
                  {matchingVehicles.length > 20
                    ? `Showing 20 of ${matchingVehicles.length} buses. Search to narrow the list.`
                    : `${matchingVehicles.length} ${matchingVehicles.length === 1 ? "bus" : "buses"} found`}
                </p>
                {matchingVehicles.length > 0 ? (
                  <div className="map-selector-list">
                    {matchingVehicles.slice(0, 20).map((vehicle) => {
                      const key = busVehicleKey(vehicle);
                      return (
                        <button
                          key={key}
                          type="button"
                          className="map-option"
                          aria-pressed={selectedVehicleKey === key}
                          onClick={() => setSelectedVehicleKey(key)}
                        >
                          <strong>
                            {busVehicleRoute(vehicle)} ·{" "}
                            {vehicle.headsign ||
                              vehicle.routeLongName ||
                              "Destination not reported"}
                          </strong>
                          {vehicle.vehicleLabel || vehicle.vehicleId ? (
                            <span>{vehicle.vehicleLabel || vehicle.vehicleId}</span>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </details>
            )}
            {feedState.isLive && bunches.length > 0 && (
              <details className="map-selector">
                <summary>Bunched now</summary>
                <p className="text-xs text-muted">
                  Buses on the same route within a few hundred metres, although timetabled at least
                  six minutes apart.
                </p>
                <div className="map-selector-list">
                  {bunches.map((bunch) => {
                    const lead = liveVehicles.find(
                      (vehicle) => vehicle.tripId != null && bunch.tripIds.includes(vehicle.tripId),
                    );
                    const key = lead ? busVehicleKey(lead) : null;
                    return (
                      <button
                        key={bunch.tripIds.join(",")}
                        type="button"
                        className="map-option"
                        disabled={key == null}
                        aria-pressed={key != null && selectedVehicleKey === key}
                        onClick={() => key && setSelectedVehicleKey(key)}
                      >
                        <strong>
                          {routeLabel(bunch.routeShortName, bunch.routeId)} ·{" "}
                          {bunch.headsign || "Destination not reported"}
                        </strong>
                        <span>
                          {bunch.tripIds.length} buses within {bunch.spreadMetres} m, timetabled{" "}
                          {bunch.scheduledGapMinutes} min apart
                        </span>
                      </button>
                    );
                  })}
                </div>
              </details>
            )}
            {notices.length > 0 && (
              <details className="map-selector">
                <summary>Service notices</summary>
                <ul className="bus-notice-list">
                  {notices.map((notice) => (
                    <li key={notice.noticeId}>
                      <details>
                        <summary>
                          <span className="eyebrow">
                            {noticeCategoryLabel(notice.category)}
                            {notice.routeShortNames.length > 0
                              ? ` · ${notice.routeShortNames.join(", ")}`
                              : null}
                          </span>
                          <strong>{notice.header}</strong>
                        </summary>
                        {notice.endsAt ? <small>Until {noticeDate(notice.endsAt)}</small> : null}
                        {notice.description && notice.description !== notice.header ? (
                          <p>{notice.description}</p>
                        ) : null}
                      </details>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {liveShapesError && (
              <RequestError
                bare
                error={liveShapesError}
                onRetry={() => retryShapes({ requestPolicy: "network-only" })}
                title="Live route paths unavailable"
              />
            )}
            <p className="mt-3 text-sm">
              <Link to="/buses/stops">Find a stop and open departures</Link>
            </p>
            <p className="mt-3 text-xs text-muted">
              {useLiveRouteShapes
                ? "Live vehicles and their routes."
                : "Scheduled routes. Live positions appear when the feed is available."}
            </p>
            {liveError && (
              <RequestError
                bare
                error={liveError}
                onRetry={() => retryLive({ requestPolicy: "network-only" })}
                title="Live bus data unavailable"
              />
            )}
            {scheduledShapesError && !scheduledShapesData && (
              <RequestError
                bare
                error={scheduledShapesError}
                onRetry={() => retryScheduledShapes({ requestPolicy: "network-only" })}
                title="Bus routes unavailable"
              />
            )}
          </LiveNetworkSummary>
        }
      />
    );
  }

  return (
    <div className="page bus-page">
      <div className="page-inner">
        <PageHeader
          eyebrow={view === "stops" ? "Stops" : "Network"}
          title={
            <>
              {view === "stops" ? "Stop" : "Route"}{" "}
              <em>{view === "stops" ? "departures" : "performance"}</em>
            </>
          }
          description={
            view === "stops"
              ? "Search for a stop to see its next services."
              : "Delay statistics for bus routes across the network."
          }
          actions={
            <span className="bus-feed-badge">
              {feedState.isLive ? <span className="live-dot" /> : null}
              {liveError ? "Updates unavailable" : feedState.badge}
            </span>
          }
        />

        {liveError ? (
          <RequestError
            error={liveError}
            onRetry={() => retryLive({ requestPolicy: "network-only" })}
            title={
              liveData
                ? "Bus updates unavailable. Showing last loaded data."
                : "Live bus data unavailable"
            }
          />
        ) : null}

        {view === "stops" && (
          <div className="bus-workspace" data-selected={selectedStopId != null}>
            <Card
              title="Find a stop"
              description="Search by stop name or public stop number."
              index={3}
              className="bus-stop-card"
            >
              <div className="bus-search-wrap">
                <SearchInput
                  value={search}
                  onChange={setSearch}
                  placeholder="Eyre Square or 522041"
                  label="Search bus stops"
                  className="w-full"
                />
                <span role="status">
                  {stopsFetching || search.trim() !== settledSearch
                    ? "Searching… Previous results may remain until the search completes."
                    : stopsError
                      ? "Search unavailable"
                      : `${stopsData?.busStops.length ?? 0} shown`}
                </span>
              </div>

              {stopsError ? (
                <RequestError
                  bare
                  error={stopsError}
                  onRetry={() => retryStops({ requestPolicy: "network-only" })}
                  title={
                    stopsData
                      ? "Stop search updates unavailable. Showing last loaded results."
                      : "Bus stops unavailable"
                  }
                />
              ) : null}

              <div className="bus-stop-list" aria-busy={stopsFetching}>
                {(stopsData?.busStops ?? []).map((stop) => (
                  <button
                    type="button"
                    key={stop.stopId}
                    className="bus-stop-option"
                    aria-pressed={stop.stopId === selectedStopId}
                    onClick={(event) => {
                      lastStopRef.current = event.currentTarget;
                      setSelectedStop(stop);
                    }}
                  >
                    <span className="bus-stop-pin" aria-hidden="true" />
                    <span>
                      <strong>{stopName(stop)}</strong>
                      <small>{stopMeta(stop)}</small>
                    </span>
                    <Icon name="arrow" />
                  </button>
                ))}
                {!stopsFetching && !stopsError && (stopsData?.busStops.length ?? 0) === 0 ? (
                  <Empty className="!min-h-40">
                    {settledSearch
                      ? `No bus stops match "${settledSearch}".`
                      : "No bus feed has been imported yet."}
                  </Empty>
                ) : null}
              </div>
            </Card>

            <Card
              title={selectedStop ? stopName(selectedStop) : "Live stop board"}
              description={
                selectedStop
                  ? `${stopMeta(selectedStop)}`
                  : "Choose a stop to see its next services."
              }
              index={4}
              className="bus-board-card"
              actions={
                <>
                  {selectedStopId && (boardLoading || liveFetching) ? (
                    <span className="code">Updating…</span>
                  ) : null}
                  {selectedStop && (
                    <button
                      type="button"
                      ref={changeStopRef}
                      className="btn btn-quiet mobile-change-stop"
                      onClick={() => setSelectedStop(null)}
                    >
                      Change stop
                    </button>
                  )}
                </>
              }
            >
              {!selectedStopId ? (
                <div className="bus-board-placeholder">
                  <Icon name="bus" />
                  <p>Pick a stop from the list.</p>
                </div>
              ) : null}

              {boardLoading ? (
                <div className="bus-board-placeholder" role="status">
                  <Icon name="bus" />
                  <p>Loading departures…</p>
                </div>
              ) : null}

              {boardResultIsCurrent && !boardHasCurrentData && liveError ? (
                <RequestError
                  bare
                  error={liveError}
                  onRetry={() => retryLive({ requestPolicy: "network-only" })}
                  title="Stop departures unavailable"
                />
              ) : null}

              {selectedStopId &&
              !boardLoading &&
              boardHasCurrentData &&
              departures.length === 0 &&
              !liveError ? (
                <Empty>
                  {feedState.isLive
                    ? "No live departures were reported for this stop."
                    : "Realtime departures are unavailable until the NTA feed reconnects."}
                </Empty>
              ) : null}

              <p className="px-5 text-sm text-muted" role="status">
                {selectedStop && boardHasCurrentData && !liveError
                  ? `${departures.length} departures for ${stopName(selectedStop)}`
                  : ""}
              </p>
              <div className="bus-board" aria-busy={liveFetching}>
                {departures.map((departure) => {
                  const delayMinutes =
                    departure.delaySeconds == null ? null : departure.delaySeconds / 60;
                  return (
                    <article
                      className="bus-departure"
                      key={`${departure.entityId ?? "entity"}-${departure.tripId ?? "trip"}-${departure.expectedTime ?? departure.fetchedAt}`}
                    >
                      <time
                        dateTime={departure.expectedTime ?? departure.scheduledTime ?? undefined}
                      >
                        {timeLabel(departure.expectedTime ?? departure.scheduledTime)}
                      </time>
                      <span className="bus-route-chip">
                        {routeLabel(departure.routeShortName, departure.routeId)}
                      </span>
                      <div>
                        <strong>
                          {departure.headsign ||
                            departure.routeLongName ||
                            "Destination unavailable"}
                        </strong>
                        <small>
                          {departure.operatorName || "Operator unavailable"}
                          {departure.scheduledTime
                            ? ` · scheduled ${timeLabel(departure.scheduledTime)}`
                            : ""}
                        </small>
                      </div>
                      <DelayPill minutes={delayMinutes} />
                    </article>
                  );
                })}
              </div>
            </Card>
          </div>
        )}

        {view === "network" && (
          <Card
            title="Routes under pressure"
            description="Up to 100 routes, ranked by average reported stop delay. These are predictions, not measured arrival punctuality."
            index={5}
            actions={
              <Segmented
                label="Bus delay window"
                options={hoursOptions}
                value={hours}
                onChange={setHours}
              />
            }
          >
            <div className="flex flex-wrap items-center gap-3 px-5 py-3">
              <SearchInput
                value={routeSearch}
                onChange={setRouteSearch}
                label="Filter sampled bus routes"
                placeholder="Route, destination or operator"
              />
              <span role="status" className="text-sm text-muted">
                {liveFetching
                  ? "Updating route history…"
                  : `${shownRoutes.length} of ${routes.length} sampled routes shown`}
              </span>
            </div>
            <div
              className="responsive-table-frame overflow-auto"
              tabIndex={0}
              role="region"
              aria-label="Bus route performance table"
              aria-busy={liveFetching}
            >
              <table role="table" className="data-table responsive-table min-w-[700px]">
                <caption className="sr-only">
                  Up to 100 sampled bus routes over {hours} hours
                </caption>
                <thead role="rowgroup">
                  <tr role="row">
                    <th role="columnheader" scope="col">
                      Route
                    </th>
                    <th role="columnheader" scope="col">
                      Operator
                    </th>
                    <th role="columnheader" scope="col" className="num">
                      Average delay
                    </th>
                    <th role="columnheader" scope="col" className="num">
                      Within 5 min
                    </th>
                    <th role="columnheader" scope="col" className="num">
                      Stop updates
                    </th>
                    <th role="columnheader" scope="col">
                      Last update
                    </th>
                  </tr>
                </thead>
                <tbody role="rowgroup">
                  {shownRoutes.map((route) => (
                    <tr
                      role="row"
                      key={`${route.feedVersionId}:${route.routeId}`}
                      data-tone={
                        route.avgDelaySeconds >= 900
                          ? "bad"
                          : route.avgDelaySeconds > 300
                            ? "warn"
                            : undefined
                      }
                    >
                      <td role="cell" data-label="Route">
                        <span className="flex items-center gap-3">
                          <span className="bus-route-chip">
                            {routeLabel(route.routeShortName, route.routeId)}
                          </span>
                          <Link
                            className="cell-main underline"
                            to={busRoutePath(route.feedVersionId, route.routeId)}
                          >
                            {route.routeLongName || "Unnamed route"}
                          </Link>
                        </span>
                      </td>
                      <td role="cell" data-label="Operator" className="text-muted">
                        {route.operatorName || "Unknown"}
                      </td>
                      <td role="cell" data-label="Average delay" className="num">
                        <DelayPill minutes={route.avgDelaySeconds / 60} precise />
                      </td>
                      <td role="cell" data-label="Within 5 min" className="num">
                        {route.onTimePct.toFixed(1)}%
                      </td>
                      <td role="cell" data-label="Stop updates" className="num text-muted">
                        {route.sampleCount.toLocaleString()}
                      </td>
                      <td
                        role="cell"
                        data-label="Last update"
                        className="text-muted"
                        title={route.lastUpdated ?? undefined}
                      >
                        {busUpdateAge(route.lastUpdated, now)}
                      </td>
                    </tr>
                  ))}
                  {!liveFetching && shownRoutes.length === 0 && !liveError ? (
                    <tr role="row">
                      <td role="cell" colSpan={6} className="py-12 text-center text-muted">
                        {routeNeedle
                          ? "No sampled routes match. Try a different search."
                          : "Route history starts building after the first realtime poll."}
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        <BusAttribution />
      </div>
    </div>
  );
}
