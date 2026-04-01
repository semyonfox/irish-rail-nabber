import DelayChart from "../components/DelayChart";
import { ROUTE_RELIABILITY } from "../graphql/queries";
import { usePollingQuery } from "../utils/usePollingQuery";
import { delayColor, formatPct } from "../utils/format";

interface Route {
  origin: string;
  destination: string;
  avgLateMinutes: number;
  onTimePct: number;
  trainCount: number;
}

interface RouteReliabilityData {
  routeReliability: Route[];
}

export default function Analytics() {
  const [{ data }] = usePollingQuery<RouteReliabilityData>({
    query: ROUTE_RELIABILITY,
    variables: { hours: 24, minTrains: 3 },
    pollInterval: 60000,
  });

  return (
    <div className="space-y-8 p-6">
      <section>
        <h2 className="mb-4 text-xl font-bold text-white">Delay Trends (24h)</h2>
        <div className="rounded-xl border border-[var(--rail-border)] bg-[var(--rail-surface)] p-4">
          <DelayChart hours={24} />
        </div>
      </section>

      <section>
        <h2 className="mb-4 text-xl font-bold text-white">Route Reliability</h2>
        <div className="overflow-auto rounded-xl border border-[var(--rail-border)] bg-[var(--rail-surface)]">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--rail-border)]">
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[var(--rail-muted)]">
                  Route
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[var(--rail-muted)]">
                  Avg Delay
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[var(--rail-muted)]">
                  On Time %
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[var(--rail-muted)]">
                  Trains
                </th>
              </tr>
            </thead>
            <tbody>
              {(data?.routeReliability ?? []).map((r) => (
                <tr
                  key={`${r.origin}-${r.destination}`}
                  className="border-b border-[var(--rail-border)] hover:bg-[var(--rail-bg)]"
                >
                  <td className="px-4 py-3 font-medium text-white">
                    {r.origin} → {r.destination}
                  </td>
                  <td className="px-4 py-3" style={{ color: delayColor(r.avgLateMinutes) }}>
                    {r.avgLateMinutes.toFixed(1)} min
                  </td>
                  <td className="px-4 py-3">{formatPct(r.onTimePct)}</td>
                  <td className="px-4 py-3">{r.trainCount}</td>
                </tr>
              ))}
              {!data?.routeReliability?.length && (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-[var(--rail-muted)]">
                    No route data available
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
