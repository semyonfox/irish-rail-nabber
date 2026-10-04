import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { BUS_STOP_STATS } from "../graphql/queries";
import { busStopPath, isBusStopStatsData } from "../utils/busHistory";
import { useCachedBusQuery } from "../utils/useCachedBusQuery";
import RequestError from "./RequestError";
import { Card, Empty, Segmented } from "./ui";

export default function BusStopRankings() {
  const [input, setInput] = useState("");
  const [search, setSearch] = useState("");
  const [hours, setHours] = useState(24);
  useEffect(() => {
    const timer = setTimeout(() => setSearch(input), 250);
    return () => clearTimeout(timer);
  }, [input]);
  const result = useCachedBusQuery({
    query: BUS_STOP_STATS,
    variables: { search, hours },
    validate: isBusStopStatsData,
  });
  return (
    <Card
      title="Stop delay rankings"
      description="Up to 200 stops, ordered by average predicted delay. P95 is the delay that 95% of reported predictions fall at or below."
    >
      <div className="card-body flex flex-wrap gap-3">
        <input
          className="input"
          aria-label="Search stop history"
          placeholder="Search stop name or ID…"
          value={input}
          onChange={(event) => setInput(event.target.value)}
        />
        <Segmented
          label="Stop ranking window"
          options={[
            { value: 6, label: "6 hours" },
            { value: 24, label: "24 hours" },
            { value: 72, label: "3 days" },
          ]}
          value={hours}
          onChange={setHours}
        />
        <span className="text-xs text-muted" role="status">
          {result.cached
            ? "Saved on this device"
            : result.fetching
              ? "Updating stops…"
              : "Rankings checked"}
        </span>
      </div>
      {result.error && (
        <RequestError
          error={result.error}
          onRetry={result.retry}
          title="Stop rankings could not refresh"
        />
      )}
      <div className="overflow-auto max-h-[36rem]">
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
            {result.data?.busStopStats.map((s) => (
              <tr key={`${s.feedVersionId}:${s.stopId}`}>
                <td>
                  <Link
                    className="cell-main block underline"
                    to={busStopPath(s.feedVersionId, s.stopId)}
                  >
                    {s.stopName}
                  </Link>
                  <small className="block text-muted">{s.stopId}</small>
                </td>
                <td className="num">{(s.avgDelaySeconds / 60).toFixed(1)}m</td>
                <td className="num">{(s.p95DelaySeconds / 60).toFixed(1)}m</td>
                <td className="num">{(s.maxDelaySeconds / 60).toFixed(1)}m</td>
                <td className="num">{s.onTimePct.toFixed(1)}%</td>
                <td className="num">{s.sampleCount.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!result.fetching && !result.data?.busStopStats.length && (
        <Empty>No recorded predictions match these stops.</Empty>
      )}
    </Card>
  );
}
