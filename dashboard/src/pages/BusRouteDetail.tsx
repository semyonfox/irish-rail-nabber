import { Link, useParams } from "react-router-dom";
import BusAttribution from "../components/BusAttribution";
import BusHistoryPanel from "../components/BusHistoryPanel";
import BusJourneysPanel from "../components/BusJourneysPanel";
import BusStopTable from "../components/BusStopTable";
import RequestError from "../components/RequestError";
import { Card, Empty, PageHeader } from "../components/ui";
import { BUS_ROUTE_STOP_DELAYS, BUS_ROUTES } from "../graphql/queries";
import type { BusRoute, BusStopDelay } from "../utils/busHistory";
import { usePollingQuery } from "../utils/usePollingQuery";

function RouteDetail({ routeId, feedVersionId }: { routeId: string; feedVersionId: number }) {
  const [metadata, retryMetadata] = usePollingQuery<{ busRoutes: BusRoute[] }>({
    query: BUS_ROUTES,
    variables: { routeId, feedVersionId, limit: 1 },
  });
  const route = metadata.data?.busRoutes[0];
  const [{ data, fetching, error }, retry] = usePollingQuery<{
    busRouteStopDelays: BusStopDelay[];
  }>({
    query: BUS_ROUTE_STOP_DELAYS,
    variables: { routeId, feedVersionId, limit: 200 },
    pause: route?.isActive === false,
    pollInterval: 30_000,
  });
  const stops = data?.busRouteStopDelays ?? [];

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
          description={route?.routeLongName || "Current stop delays and recorded history"}
        />
        {metadata.error && (
          <RequestError
            error={metadata.error}
            onRetry={() => retryMetadata({ requestPolicy: "network-only" })}
            title="Route details unavailable"
          />
        )}
        {!metadata.fetching && metadata.data && !route ? (
          <Empty>This route was not found in the selected schedule.</Empty>
        ) : null}
        {route && !route.isActive ? (
          <p className="text-sm text-muted">
            This route belongs to an older schedule. Its recorded history stays available.{" "}
            <Link
              className="underline"
              to={`/buses/routes?q=${encodeURIComponent(route.routeShortName || routeId)}`}
            >
              Find it in the current schedule
            </Link>
          </p>
        ) : null}
        <BusHistoryPanel routeId={routeId} feedVersionId={feedVersionId} />
        {route?.isActive !== false && (
          <Card
            title="Current stop delays"
            description="Upcoming reported stops, up to 200 predictions. Cancelled trips and skipped stops have no delay estimate."
            actions={fetching ? <span className="text-xs text-muted">Updating…</span> : undefined}
          >
            {error && (
              <RequestError
                error={error}
                onRetry={() => retry({ requestPolicy: "network-only" })}
                title="Stop predictions unavailable"
              />
            )}
            {stops.length > 0 ? (
              <BusStopTable stops={stops} feedVersionId={feedVersionId} routeId={routeId} />
            ) : !fetching && !error ? (
              <Empty>
                No current predictions for this route. Some operators publish a timetable only.
              </Empty>
            ) : null}
          </Card>
        )}
        <BusJourneysPanel routeId={routeId} feedVersionId={feedVersionId} />
        <BusAttribution />
      </div>
    </div>
  );
}

export default function BusRouteDetail() {
  const { routeId, feedVersionId } = useParams();
  const version = Number(feedVersionId);
  if (!routeId || !Number.isSafeInteger(version) || version < 1) {
    return <Empty>Invalid bus route link.</Empty>;
  }
  return <RouteDetail key={`${version}:${routeId}`} routeId={routeId} feedVersionId={version} />;
}
