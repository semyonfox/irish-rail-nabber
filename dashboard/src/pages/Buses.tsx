import { useEffect, useMemo, useState } from "react";
import BusVehicleMap from "../components/BusVehicleMap";
import RequestError from "../components/RequestError";
import { Card, DelayPill, Empty, Icon, PageHeader, SearchInput, Segmented } from "../components/ui";
import { BUS_LIVE_OVERVIEW, BUS_SCHEDULED_ROUTE_SHAPES, BUS_STOPS } from "../graphql/queries";
import { busFeedState, type BusRealtimeStatus } from "../utils/busRealtime";
import type { BusRouteShape } from "../utils/busShapes";
import type { BusVehicle } from "../utils/busVehicles";
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
  busVehicles: BusVehicle[];
  busLiveRouteShapes: BusRouteShape[];
  busRouteDelays: BusRouteDelay[];
}

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

export default function Buses() {
  const [search, setSearch] = useState("");
  const [settledSearch, setSettledSearch] = useState("");
  const [selectedStopId, setSelectedStopId] = useState<string | null>(null);
  const [hours, setHours] = useState(24);

  useEffect(() => {
    const id = setTimeout(() => setSettledSearch(search.trim()), 250);
    return () => clearTimeout(id);
  }, [search]);

  const [{ data: stopsData, fetching: stopsFetching, error: stopsError }, retryStops] =
    usePollingQuery<BusStopsData>({
      query: BUS_STOPS,
      variables: { search: settledSearch || null, limit: 60 },
    });

  const selectedStop = useMemo(
    () => stopsData?.busStops.find((stop) => stop.stopId === selectedStopId) ?? null,
    [selectedStopId, stopsData?.busStops],
  );

  const [
    { data: scheduledShapesData, fetching: scheduledShapesFetching, error: scheduledShapesError },
    retryScheduledShapes,
  ] = usePollingQuery<BusScheduledRouteShapesData>({
    query: BUS_SCHEDULED_ROUTE_SHAPES,
    variables: { stopId: selectedStopId, limit: 24 },
  });

  const [{ data: liveData, fetching: liveFetching, error: liveError }, retryLive] =
    usePollingQuery<BusLiveOverviewData>({
      query: BUS_LIVE_OVERVIEW,
      variables: {
        stopId: selectedStopId ?? "",
        includeBoard: selectedStopId != null,
        boardLimit: 30,
        vehicleLimit: 2_000,
        shapeLimit: 100,
        hours,
        routeLimit: 20,
      },
      pollInterval: 60_000,
    });

  const departures = liveData?.busStopBoard ?? [];
  const realtimeStatus = liveData?.busRealtimeStatus ?? null;
  const feedState = busFeedState(realtimeStatus, liveFetching && !liveData);
  const vehicles = liveData?.busVehicles ?? [];
  const liveRouteShapes = liveData?.busLiveRouteShapes ?? [];
  const scheduledRouteShapes = scheduledShapesData?.busScheduledRouteShapes ?? [];
  const useLiveRouteShapes = feedState.isLive && liveRouteShapes.length > 0;
  const routeShapes = useLiveRouteShapes ? liveRouteShapes : scheduledRouteShapes;
  const routes = liveData?.busRouteDelays ?? [];
  const busesOnTime = routes.length
    ? routes.reduce((sum, route) => sum + route.onTimePct, 0) / routes.length
    : null;

  return (
    <div className="page bus-page">
      <div className="page-inner">
        <PageHeader
          eyebrow="NTA bus network"
          title={
            <>
              Your stop, <em>without the guesswork</em>
            </>
          }
          description="NTA city, regional and national bus stops, departures and route reliability, with realtime status checked against the collector's latest successful poll."
          actions={
            <span className="bus-feed-badge">
              {feedState.isLive ? <span className="live-dot" /> : null}
              {feedState.badge}
            </span>
          }
        />

        {liveError && !liveData ? (
          <RequestError
            error={liveError}
            onRetry={() => retryLive({ requestPolicy: "network-only" })}
            title="Live bus data unavailable"
          />
        ) : null}

        {scheduledShapesError && !scheduledShapesData ? (
          <RequestError
            error={scheduledShapesError}
            onRetry={() => retryScheduledShapes({ requestPolicy: "network-only" })}
            title="Bus route map unavailable"
          />
        ) : null}

        <section className="bus-hero rise" style={{ "--i": 1 } as React.CSSProperties}>
          <div>
            <span className="bus-route-sign">BUS</span>
            <p>City, regional &amp; national</p>
          </div>
          <div className="bus-destination">
            <span>Next departures</span>
            <strong>{selectedStop ? stopName(selectedStop) : "Choose a stop"}</strong>
          </div>
          <div className="bus-hero-stat">
            <span>Routes sampled</span>
            <strong>{routes.length || "--"}</strong>
          </div>
          <div className="bus-hero-stat">
            <span>Within 5 min</span>
            <strong>{busesOnTime == null ? "--" : `${busesOnTime.toFixed(0)}%`}</strong>
          </div>
        </section>

        <BusVehicleMap
          vehicles={feedState.isLive ? vehicles : []}
          routeShapes={routeShapes}
          realtimeStatus={realtimeStatus}
          fetching={liveFetching}
          shapesFetching={scheduledShapesFetching}
          shapeMode={useLiveRouteShapes ? "live" : "scheduled"}
          shapeFocusKey={selectedStopId ?? "network"}
        />

        <div className="bus-workspace">
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
              <span>{stopsData?.busStops.length ?? 0} shown</span>
            </div>

            {stopsError && !stopsData ? (
              <RequestError
                bare
                error={stopsError}
                onRetry={() => retryStops({ requestPolicy: "network-only" })}
                title="Bus stops unavailable"
              />
            ) : null}

            <div className="bus-stop-list" aria-busy={stopsFetching}>
              {(stopsData?.busStops ?? []).map((stop) => (
                <button
                  type="button"
                  key={stop.stopId}
                  className="bus-stop-option"
                  aria-pressed={stop.stopId === selectedStopId}
                  onClick={() => setSelectedStopId(stop.stopId)}
                >
                  <span className="bus-stop-pin" aria-hidden="true" />
                  <span>
                    <strong>{stopName(stop)}</strong>
                    <small>{stopMeta(stop)}</small>
                  </span>
                  <Icon name="arrow" />
                </button>
              ))}
              {!stopsFetching && (stopsData?.busStops.length ?? 0) === 0 ? (
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
                ? `${stopMeta(selectedStop)} · refreshed from NTA TripUpdates`
                : "Choose a stop to see its next services."
            }
            index={4}
            className="bus-board-card"
            actions={liveFetching ? <span className="code">Updating…</span> : undefined}
          >
            {!selectedStopId ? (
              <div className="bus-board-placeholder">
                <Icon name="bus" />
                <p>Pick a stop from the list.</p>
              </div>
            ) : null}

            {selectedStopId && !liveFetching && departures.length === 0 && !liveError ? (
              <Empty>
                {feedState.isLive
                  ? "No live departures were reported for this stop."
                  : "Realtime departures are unavailable until the NTA feed reconnects."}
              </Empty>
            ) : null}

            <div className="bus-board" aria-live="polite">
              {departures.map((departure) => {
                const delayMinutes =
                  departure.delaySeconds == null ? null : departure.delaySeconds / 60;
                return (
                  <article
                    className="bus-departure"
                    key={`${departure.entityId ?? "entity"}-${departure.tripId ?? "trip"}-${departure.expectedTime ?? departure.fetchedAt}`}
                  >
                    <time dateTime={departure.expectedTime ?? undefined}>
                      {timeLabel(departure.expectedTime)}
                    </time>
                    <span className="bus-route-chip">
                      {routeLabel(departure.routeShortName, departure.routeId)}
                    </span>
                    <div>
                      <strong>
                        {departure.headsign || departure.routeLongName || "Destination unavailable"}
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

        <Card
          title="Routes under pressure"
          description="Routes with the highest average delay in the selected window."
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
          <div className="overflow-auto">
            <table className="data-table min-w-[700px]">
              <thead>
                <tr>
                  <th>Route</th>
                  <th>Operator</th>
                  <th className="num">Average delay</th>
                  <th className="num">Within 5 min</th>
                  <th className="num">Stop updates</th>
                </tr>
              </thead>
              <tbody>
                {routes.map((route) => (
                  <tr
                    key={route.routeId}
                    data-tone={
                      route.avgDelaySeconds >= 900
                        ? "bad"
                        : route.avgDelaySeconds > 300
                          ? "warn"
                          : undefined
                    }
                  >
                    <td>
                      <span className="flex items-center gap-3">
                        <span className="bus-route-chip">
                          {routeLabel(route.routeShortName, route.routeId)}
                        </span>
                        <span className="cell-main">{route.routeLongName || "Unnamed route"}</span>
                      </span>
                    </td>
                    <td className="text-muted">{route.operatorName || "Unknown"}</td>
                    <td className="num">
                      <DelayPill minutes={route.avgDelaySeconds / 60} precise />
                    </td>
                    <td className="num">{route.onTimePct.toFixed(1)}%</td>
                    <td className="num text-muted">{route.sampleCount.toLocaleString()}</td>
                  </tr>
                ))}
                {!liveFetching && routes.length === 0 && !liveError ? (
                  <tr>
                    <td colSpan={5} className="py-12 text-center text-muted">
                      Route history starts building after the first realtime poll.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </Card>

        <p className="bus-attribution">
          Bus schedule and realtime data provided by the{" "}
          <a href="https://data.gov.ie/dataset/nta-gtfs" target="_blank" rel="noreferrer">
            National Transport Authority
          </a>{" "}
          under{" "}
          <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">
            CC BY 4.0
          </a>
          . Data is supplied as is and may contain errors.
        </p>
      </div>
    </div>
  );
}
