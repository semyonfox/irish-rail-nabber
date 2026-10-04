import { Link, useParams } from "react-router-dom";
import BusHistoryPanel from "../components/BusHistoryPanel";
import RequestError from "../components/RequestError";
import { Empty, PageHeader } from "../components/ui";
import { BUS_STOP_STATS } from "../graphql/queries";
import { isBusStopStatsData } from "../utils/busHistory";
import { useCachedBusQuery } from "../utils/useCachedBusQuery";

function StopDetail({ feedVersionId, stopId }: { feedVersionId: number; stopId: string }) {
  const result = useCachedBusQuery({
    query: BUS_STOP_STATS,
    variables: { feedVersionId, stopId, hours: 72 },
    validate: isBusStopStatsData,
  });
  return (
    <div className="page">
      <div className="page-inner">
        <Link className="text-sm underline" to="/buses/history">
          ← Bus history and stop rankings
        </Link>
        <PageHeader
          eyebrow="Bus stop history"
          title={result.data?.busStopStats[0]?.stopName || stopId}
          description="Recorded predictions at this stop, across routes in this schedule."
        />
        {result.error && (
          <RequestError
            error={result.error}
            onRetry={result.retry}
            title="Stop details could not refresh"
          />
        )}
        <BusHistoryPanel feedVersionId={feedVersionId} stopId={stopId} />
      </div>
    </div>
  );
}
export default function BusStopDetail() {
  const { feedVersionId, stopId } = useParams();
  const version = Number(feedVersionId);
  if (!stopId || !Number.isSafeInteger(version) || version < 1)
    return <Empty>Invalid bus stop link.</Empty>;
  return <StopDetail key={`${version}:${stopId}`} feedVersionId={version} stopId={stopId} />;
}
