import CountryBoard from "../components/CountryBoard";
import { ROUTE_RELIABILITY, STATION_DELAY_STATS } from "../graphql/queries";
import { usePollingQuery } from "../utils/usePollingQuery";
import { delayColor, formatPct } from "../utils/format";

interface Route {
  origin: string;
  destination: string;
  avgLateMinutes: number;
  onTimePct: number;
  trainCount: number;
}

interface StationStats {
  stationCode: string;
  stationDesc: string;
  avgLateMinutes: number;
  maxLateMinutes: number;
  onTimePct: number;
  totalEvents: number;
}

interface RouteReliabilityData {
  routeReliability: Route[];
}

interface StationDelayStatsData {
  stationDelayStats: StationStats[];
}

function DelayBadge({ value }: { value: number }) {
  return (
    <span
      className="inline-flex min-w-14 justify-center rounded border border-current px-2 py-1 text-xs font-bold"
      style={{ color: delayColor(value) }}
    >
      {value <= 0 ? "RT" : `+${value.toFixed(1)}m`}
    </span>
  );
}

export default function Analytics() {
  const [{ data: routeData }] = usePollingQuery<RouteReliabilityData>({
    query: ROUTE_RELIABILITY,
    variables: { hours: 24, minTrains: 3 },
    pollInterval: 60000,
  });

  const [{ data: stationData }] = usePollingQuery<StationDelayStatsData>({
    query: STATION_DELAY_STATS,
    variables: { hours: 24, limit: 20 },
    pollInterval: 60000,
  });

  const routes = routeData?.routeReliability ?? [];
  const stations = stationData?.stationDelayStats ?? [];
  const delayedRoutes = routes.filter((route) => route.avgLateMinutes >= 5).length;
  const delayedStations = stations.filter((station) => station.avgLateMinutes >= 5).length;

  return (
    <div className="h-full overflow-auto p-4 md:p-6">
      <div className="mx-auto max-w-7xl space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase text-[var(--rail-green)]">
              Network board
            </p>
            <h1 className="text-2xl font-semibold text-white">Ireland live rail operations</h1>
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
            <div className="rounded border border-[var(--rail-border)] bg-[var(--rail-surface)] px-3 py-2">
              <div className="text-xs text-[var(--rail-muted)]">Delayed routes</div>
              <div className="text-lg font-semibold text-[var(--rail-orange)]">{delayedRoutes}</div>
            </div>
            <div className="rounded border border-[var(--rail-border)] bg-[var(--rail-surface)] px-3 py-2">
              <div className="text-xs text-[var(--rail-muted)]">Delayed stations</div>
              <div className="text-lg font-semibold text-[var(--rail-orange)]">
                {delayedStations}
              </div>
            </div>
            <div className="rounded border border-[var(--rail-border)] bg-[var(--rail-surface)] px-3 py-2">
              <div className="text-xs text-[var(--rail-muted)]">Routes tracked</div>
              <div className="text-lg font-semibold text-white">{routes.length}</div>
            </div>
            <div className="rounded border border-[var(--rail-border)] bg-[var(--rail-surface)] px-3 py-2">
              <div className="text-xs text-[var(--rail-muted)]">Stations tracked</div>
              <div className="text-lg font-semibold text-white">{stations.length}</div>
            </div>
          </div>
        </div>

        <CountryBoard limit={120} minutes={60} />

        <section className="grid gap-5 xl:grid-cols-2">
          <div className="overflow-hidden rounded-lg border border-[var(--rail-border)] bg-[var(--rail-surface)]">
            <div className="border-b border-[var(--rail-border)] px-4 py-3">
              <p className="text-xs font-semibold uppercase text-[var(--rail-green)]">Routes</p>
              <h2 className="text-lg font-semibold text-white">Worst delays in the last 24h</h2>
            </div>
            <div className="overflow-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="border-b border-[var(--rail-border)] text-left text-xs font-semibold uppercase text-[var(--rail-muted)]">
                    <th className="px-3 py-2">Route</th>
                    <th className="px-3 py-2">Avg</th>
                    <th className="px-3 py-2">Within 5m</th>
                    <th className="px-3 py-2">Trains</th>
                  </tr>
                </thead>
                <tbody>
                  {routes.slice(0, 12).map((route) => (
                    <tr
                      key={`${route.origin}-${route.destination}`}
                      className="border-b border-[var(--rail-border)]"
                    >
                      <td className="px-3 py-3">
                        <div className="font-medium text-white">{route.origin}</div>
                        <div className="text-xs text-[var(--rail-muted)]">
                          to {route.destination}
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <DelayBadge value={route.avgLateMinutes} />
                      </td>
                      <td className="px-3 py-3 text-white">{formatPct(route.onTimePct)}</td>
                      <td className="px-3 py-3 text-[var(--rail-muted)]">{route.trainCount}</td>
                    </tr>
                  ))}
                  {routes.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-3 py-8 text-center text-[var(--rail-muted)]">
                        No route reliability data
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>

          <div className="overflow-hidden rounded-lg border border-[var(--rail-border)] bg-[var(--rail-surface)]">
            <div className="border-b border-[var(--rail-border)] px-4 py-3">
              <p className="text-xs font-semibold uppercase text-[var(--rail-green)]">Stations</p>
              <h2 className="text-lg font-semibold text-white">Worst station pressure</h2>
            </div>
            <div className="overflow-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="border-b border-[var(--rail-border)] text-left text-xs font-semibold uppercase text-[var(--rail-muted)]">
                    <th className="px-3 py-2">Station</th>
                    <th className="px-3 py-2">Avg</th>
                    <th className="px-3 py-2">Worst</th>
                    <th className="px-3 py-2">Events</th>
                  </tr>
                </thead>
                <tbody>
                  {stations.slice(0, 12).map((station) => (
                    <tr key={station.stationCode} className="border-b border-[var(--rail-border)]">
                      <td className="px-3 py-3">
                        <div className="font-medium text-white">{station.stationDesc}</div>
                        <div className="text-xs text-[var(--rail-muted)]">
                          {station.stationCode} · {formatPct(station.onTimePct)} within 5m
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <DelayBadge value={station.avgLateMinutes} />
                      </td>
                      <td className="px-3 py-3 text-white">+{station.maxLateMinutes}m</td>
                      <td className="px-3 py-3 text-[var(--rail-muted)]">{station.totalEvents}</td>
                    </tr>
                  ))}
                  {stations.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-3 py-8 text-center text-[var(--rail-muted)]">
                        No station delay data
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
