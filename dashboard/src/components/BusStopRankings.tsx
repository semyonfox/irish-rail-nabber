import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { BUS_STOP_STATS } from "../graphql/queries";
import {
  busHistoryMaxHours,
  busHistoryRanges,
  busStopPath,
  type BusStopStats,
} from "../utils/busHistory";
import { usePollingQuery } from "../utils/usePollingQuery";
import RequestError from "./RequestError";
import { Card, Empty, SearchInput, Segmented } from "./ui";

export default function BusStopRankings() {
  const { user } = useAuth();
  const maxHours = busHistoryMaxHours(user?.role);
  const [input, setInput] = useState("");
  const [search, setSearch] = useState("");
  const [selection, setSelection] = useState(24);
  const hours = Math.min(selection, maxHours);

  useEffect(() => {
    const timer = setTimeout(() => setSearch(input.trim()), 250);
    return () => clearTimeout(timer);
  }, [input]);

  const [{ data, fetching, error }, retry] = usePollingQuery<{ busStopStats: BusStopStats[] }>({
    query: BUS_STOP_STATS,
    variables: { search: search || null, hours, limit: 200 },
    pollInterval: 120_000,
  });
  const stops = data?.busStopStats ?? [];

  return (
    <Card
      title="Stop delay rankings"
      description="Up to 200 stops, ordered by average predicted delay. P95 is the delay that 95% of reported predictions fall at or below."
    >
      <div className="card-body flex flex-wrap items-center gap-3">
        <SearchInput
          value={input}
          onChange={setInput}
          label="Search stop history"
          placeholder="Stop name or ID"
        />
        <Segmented
          label="Stop ranking window"
          options={busHistoryRanges(maxHours)}
          value={hours}
          onChange={setSelection}
        />
        <span className="text-xs text-muted" role="status">
          {fetching ? "Updating stops…" : `${stops.length} stops shown`}
        </span>
      </div>
      {error && (
        <RequestError
          error={error}
          onRetry={() => retry({ requestPolicy: "network-only" })}
          title="Stop rankings could not refresh"
        />
      )}
      {stops.length > 0 ? (
        <div className="max-h-[36rem] overflow-auto">
          <table className="data-table min-w-[680px]">
            <thead>
              <tr>
                <th>Stop</th>
                <th className="num">Average</th>
                <th className="num">P95</th>
                <th className="num">Maximum</th>
                <th className="num">Within target</th>
                <th className="num">Observations</th>
              </tr>
            </thead>
            <tbody>
              {stops.map((stop) => (
                <tr key={`${stop.feedVersionId}:${stop.stopId}`}>
                  <td>
                    <Link
                      className="cell-main block underline"
                      to={busStopPath(stop.feedVersionId, stop.stopId)}
                    >
                      {stop.stopName}
                    </Link>
                    <small className="block text-muted">{stop.stopId}</small>
                  </td>
                  <td className="num">{(stop.avgDelaySeconds / 60).toFixed(1)}m</td>
                  <td className="num">{(stop.p95DelaySeconds / 60).toFixed(1)}m</td>
                  <td className="num">{(stop.maxDelaySeconds / 60).toFixed(1)}m</td>
                  <td className="num">{stop.onTimePct.toFixed(1)}%</td>
                  <td className="num">{stop.sampleCount.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : !fetching && !error ? (
        <Empty>No recorded predictions match these stops.</Empty>
      ) : null}
    </Card>
  );
}
