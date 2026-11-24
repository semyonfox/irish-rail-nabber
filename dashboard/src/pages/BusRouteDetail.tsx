import { Link, useParams } from "react-router-dom";
import BusVehicleMap from "../components/BusVehicleMap";
import type { BusVehicle } from "../utils/busVehicles";
import type { BusRouteShape } from "../utils/busShapes";
import BusHistoryPanel from "../components/BusHistoryPanel";
import RequestError from "../components/RequestError";
import { Card, Empty, PageHeader } from "../components/ui";
import { BUS_LIVE_OVERVIEW, BUS_ROUTES, BUS_ROUTE_STOP_DELAYS } from "../graphql/queries";
import { isBusLiveOverviewData } from "../utils/busData";
import { busFeedState, busSourceStatus } from "../utils/busRealtime";
import { isBusRoutesData, isBusRouteStopData } from "../utils/busHistory";
import { useCachedBusQuery } from "../utils/useCachedBusQuery";
import BusStopTable from "../components/BusStopTable";
import BusJourneysPanel from "../components/BusJourneysPanel";

const noVehicles: BusVehicle[] = [];
const noShapes: BusRouteShape[] = [];

function RouteDetail({ routeId, feedVersionId }: { routeId: string; feedVersionId: number }) {
  const metadata = useCachedBusQuery({
    query: BUS_ROUTES,
    variables: { routeId, feedVersionId, limit: 1 },
    validate: isBusRoutesData,
    pollInterval: 900_000,
  });
  const route = metadata.data?.busRoutes[0];
  const live = useCachedBusQuery({
    query: BUS_LIVE_OVERVIEW,
    variables: {
      routeId,
      stopId: "",
      includeBoard: false,
      includeVehicles: true,
      includeShapes: false,
      includeDelays: false,
      vehicleLimit: 200,
    },
    validate: isBusLiveOverviewData,
    pause: !route?.isActive,
    pollInterval: 60_000,
  });
  const sourceStatus = busSourceStatus(
    live.data?.busRealtimeStatus ?? null,
    "vehicles",
    Date.now(),
  );
  const liveVehicles =
    route?.isActive && busFeedState(sourceStatus, live.fetching).isLive
      ? (live.data?.busVehicles ?? noVehicles)
      : noVehicles;
  const { data, fetching, error, retry } = useCachedBusQuery({
    validate: isBusRouteStopData,
    query: BUS_ROUTE_STOP_DELAYS,
    variables: { routeId, feedVersionId },
    pollInterval: 30_000,
  });
  return (
    <div className="page">
      <div className="page-inner">
        <Link to="/buses/routes" className="text-sm underline">
          ← All bus routes
        </Link>
        <PageHeader
          eyebrow={route?.operatorName || "Bus route"}
          title={
            <>
              Route <em>{route?.routeShortName || routeId}</em>
            </>
          }
          description={route?.routeLongName || "Route delays and recorded history"}
        />
        {metadata.error && (
          <RequestError
            error={metadata.error}
            onRetry={metadata.retry}
            title="Route details could not refresh"
          />
        )}
        {route && !route.isActive && (
          <p className="text-sm text-muted">
            This route belongs to an older schedule. Its recorded history stays available.{" "}
            <Link
              className="underline"
              to={`/buses/routes?q=${encodeURIComponent(route.routeShortName || routeId)}`}
            >
              Find the current schedule →
            </Link>
          </p>
        )}
        {!metadata.fetching && metadata.data && !route && (
          <Empty>This route was not found in the selected schedule.</Empty>
        )}
        {route?.routeShortName && (
          <Link
            className="text-sm underline"
            to={`/buses/published?q=${encodeURIComponent(route.routeShortName)}`}
          >
            Published NTA history for route {route.routeShortName}
          </Link>
        )}
        <Card
          title="Route map and stops"
          description="Timetable paths in both directions, including route variants. Select a stop for departures and delay history."
        >
          <BusVehicleMap
            vehicles={liveVehicles}
            routeShapes={noShapes}
            focusedRouteId={routeId}
            feedVersionId={feedVersionId}
            realtimeStatus={sourceStatus}
            fetching={live.fetching}
            shapesFetching={false}
            shapeMode="scheduled"
            shapeFocusKey={`${feedVersionId}:${routeId}`}
          />
        </Card>
        <p className="text-sm text-muted">
          Some operators provide timetable data only. Live positions and delay statistics are
          available when the operator supplies them.
        </p>
        <BusHistoryPanel routeId={routeId} feedVersionId={feedVersionId} />
        <Card
          title="Current stop delays"
          description="Next reported stops, up to 200 predictions. Cancellations and skipped stops have no delay estimate."
          actions={fetching ? <span className="text-xs text-muted">Updating…</span> : undefined}
        >
          {error && (
            <RequestError
              error={error}
              onRetry={retry}
              title="Stop predictions could not refresh"
            />
          )}
          <BusStopTable stops={data?.busRouteStopDelays ?? []} feedVersionId={feedVersionId} />
          {!fetching && !data?.busRouteStopDelays.length && !error && (
            <Empty>No current predictions for this route. Recorded history remains above.</Empty>
          )}
        </Card>
        <BusJourneysPanel routeId={routeId} feedVersionId={feedVersionId} />
        <p className="bus-attribution">
          Data from <a href="https://www.nationaltransport.ie/">NTA</a>,{" "}
          <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>. Supplied as is.
        </p>
      </div>
    </div>
  );
}

export default function BusRouteDetail() {
  const { routeId, feedVersionId } = useParams();
  const version = Number(feedVersionId);
  if (!routeId || !Number.isSafeInteger(version) || version < 1)
    return <Empty>Invalid bus route link.</Empty>;
  return <RouteDetail key={`${version}:${routeId}`} routeId={routeId} feedVersionId={version} />;
}
