import { Link, useParams } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import BusAttribution from "../components/BusAttribution";
import BusStopTable from "../components/BusStopTable";
import RequestError from "../components/RequestError";
import { Card, Empty, PageHeader } from "../components/ui";
import { BUS_JOURNEY } from "../graphql/queries";
import { busHistoryMaxHours, busRoutePath, type BusStopDelay } from "../utils/busHistory";
import { usePollingQuery } from "../utils/usePollingQuery";

function JourneyDetail({
  feedVersionId,
  routeId,
  tripInstanceKey,
}: {
  feedVersionId: number;
  routeId: string;
  tripInstanceKey: string;
}) {
  const { user } = useAuth();
  const hours = busHistoryMaxHours(user?.role, "journeys");
  const [{ data, fetching, error }, retry] = usePollingQuery<{
    busJourneyStops: BusStopDelay[];
  }>({
    query: BUS_JOURNEY,
    variables: { feedVersionId, routeId, tripInstanceKey, hours },
    pollInterval: 60_000,
  });
  const stops = data?.busJourneyStops ?? [];
  const first = stops[0];

  return (
    <div className="page">
      <div className="page-inner">
        <Link className="text-sm underline" to={busRoutePath(feedVersionId, routeId)}>
          ← Back to the route
        </Link>
        <PageHeader
          eyebrow="Recorded bus journey"
          title={first?.headsign || first?.tripId || "Journey history"}
          description="Last reported prediction at each stop. Expected times are predictions, not confirmed arrivals."
        />
        {error && (
          <RequestError
            error={error}
            onRetry={() => retry({ requestPolicy: "network-only" })}
            title="Journey unavailable"
          />
        )}
        <Card
          title="Stop by stop"
          description={
            first
              ? `Trip ${first.tripId ?? "unknown"} · ${stops.length} recorded stops`
              : `Searches the last ${hours} hours of recorded predictions.`
          }
          actions={fetching ? <span className="text-xs text-muted">Updating…</span> : undefined}
        >
          {stops.length > 0 ? (
            <BusStopTable
              stops={stops}
              feedVersionId={feedVersionId}
              routeId={routeId}
              showJourney={false}
            />
          ) : !fetching && !error ? (
            <Empty>
              No stop predictions were recorded for this journey in your history window.
            </Empty>
          ) : null}
        </Card>
        <BusAttribution />
      </div>
    </div>
  );
}

export default function BusJourneyDetail() {
  const { feedVersionId, routeId, tripInstanceKey } = useParams();
  const version = Number(feedVersionId);
  if (!routeId || !tripInstanceKey || !Number.isSafeInteger(version) || version < 1) {
    return <Empty>Invalid bus journey link.</Empty>;
  }
  return (
    <JourneyDetail
      key={`${version}:${routeId}:${tripInstanceKey}`}
      feedVersionId={version}
      routeId={routeId}
      tripInstanceKey={tripInstanceKey}
    />
  );
}
