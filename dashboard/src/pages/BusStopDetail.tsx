import { Link, useParams } from "react-router-dom";
import BusAttribution from "../components/BusAttribution";
import BusHistoryPanel from "../components/BusHistoryPanel";
import RequestError from "../components/RequestError";
import { Empty, PageHeader } from "../components/ui";
import { BUS_STOP_STATS } from "../graphql/queries";
import type { BusStopStats } from "../utils/busHistory";
import { usePollingQuery } from "../utils/usePollingQuery";

function StopDetail({ feedVersionId, stopId }: { feedVersionId: number; stopId: string }) {
  const [{ data, error }, retry] = usePollingQuery<{ busStopStats: BusStopStats[] }>({
    query: BUS_STOP_STATS,
    variables: { feedVersionId, stopId, hours: 72, limit: 1 },
  });

  return (
    <div className="page">
      <div className="page-inner">
        <Link className="text-sm underline" to="/buses/history">
          ← Network history and stop rankings
        </Link>
        <PageHeader
          eyebrow="Stop history"
          title={data?.busStopStats[0]?.stopName || stopId}
          description="Recorded predictions at this stop across every route in this schedule."
        />
        {error && (
          <RequestError
            error={error}
            onRetry={() => retry({ requestPolicy: "network-only" })}
            title="Stop details unavailable"
          />
        )}
        <BusHistoryPanel feedVersionId={feedVersionId} stopId={stopId} />
        <BusAttribution />
      </div>
    </div>
  );
}

export default function BusStopDetail() {
  const { feedVersionId, stopId } = useParams();
  const version = Number(feedVersionId);
  if (!stopId || !Number.isSafeInteger(version) || version < 1) {
    return <Empty>Invalid bus stop link.</Empty>;
  }
  return <StopDetail key={`${version}:${stopId}`} feedVersionId={version} stopId={stopId} />;
}
