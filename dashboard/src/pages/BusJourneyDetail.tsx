import { Link, useParams } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import BusStopTable from "../components/BusStopTable";
import RequestError from "../components/RequestError";
import { Card, Empty, PageHeader } from "../components/ui";
import { BUS_JOURNEY } from "../graphql/queries";
import { busRoutePath, isBusJourneyData } from "../utils/busHistory";
import { useCachedBusQuery } from "../utils/useCachedBusQuery";

function JourneyDetail({
  feedVersionId,
  tripInstanceKey,
}: {
  feedVersionId: number;
  tripInstanceKey: string;
}) {
  const { user } = useAuth();
  const paid = !!user && ["coffee", "pro", "admin"].includes(user.role);
  const result = useCachedBusQuery({
    query: BUS_JOURNEY,
    variables: { feedVersionId, tripInstanceKey, hours: paid ? 0 : 72 },
    validate: isBusJourneyData,
    cacheScope: `${user?.id ?? "anonymous"}:${user?.role ?? "free"}`,
  });
  const journey = result.data?.busJourneys[0];
  return (
    <div className="page">
      <div className="page-inner">
        <Link
          className="text-sm underline"
          to={
            journey?.routeId
              ? busRoutePath({ feedVersionId, routeId: journey.routeId })
              : "/buses/routes"
          }
        >
          ← Bus route
        </Link>
        <PageHeader
          eyebrow="Recorded bus journey"
          title={journey?.headsign || journey?.tripId || "Journey history"}
          description="Last reported prediction at each stop. Expected times are predictions, not confirmed arrivals."
        />
        {result.error && (
          <RequestError
            error={result.error}
            onRetry={result.retry}
            title="Journey could not refresh"
          />
        )}
        <span className="text-xs text-muted" role="status">
          {result.cached
            ? "Saved on this device"
            : result.fetching
              ? "Updating journey…"
              : "Journey checked"}
        </span>
        <Card
          title="Stop-by-stop history"
          description={
            journey
              ? `Trip ${journey.tripId ?? "unknown"} · ${journey.stopCount} recorded stops`
              : "History starts when this journey is first observed."
          }
        >
          <BusStopTable feedVersionId={feedVersionId} stops={result.data?.busJourneyStops ?? []} />
          {!result.fetching && !result.data?.busJourneyStops.length && (
            <Empty>No stop predictions were recorded within your available history window.</Empty>
          )}
        </Card>
      </div>
    </div>
  );
}
export default function BusJourneyDetail() {
  const { feedVersionId, tripInstanceKey } = useParams();
  const version = Number(feedVersionId);
  if (!tripInstanceKey || !Number.isSafeInteger(version) || version < 1)
    return <Empty>Invalid bus journey link.</Empty>;
  return (
    <JourneyDetail
      key={`${version}:${tripInstanceKey}`}
      feedVersionId={version}
      tripInstanceKey={tripInstanceKey}
    />
  );
}
