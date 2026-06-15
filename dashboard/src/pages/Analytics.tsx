import CountryBoard from "../components/CountryBoard";
import DelayChart from "../components/DelayChart";
import RouteReliabilityChart from "../components/RouteReliabilityChart";
import StationRiskChart from "../components/StationRiskChart";
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

function impactMinutes(avgLateMinutes: number, count: number) {
  return Math.max(0, avgLateMinutes) * count;
}

function MetricTile({
  label,
  value,
  detail,
  tone = "text-white",
}: {
  label: string;
  value: string | number;
  detail: string;
  tone?: string;
}) {
  return (
    <div className="rounded-lg border border-[var(--rail-border)] bg-[var(--rail-surface)] px-4 py-3">
      <div className="text-xs uppercase text-[var(--rail-muted)]">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${tone}`}>{value}</div>
      <div className="mt-1 line-clamp-2 text-xs text-[var(--rail-muted)]">{detail}</div>
    </div>
  );
}

function BarMeter({ value, max, tone }: { value: number; max: number; tone: string }) {
  const width = max > 0 ? Math.max(8, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className="h-2 w-full rounded bg-[var(--rail-bg)]">
      <div className={`h-2 rounded ${tone}`} style={{ width: `${width}%` }} />
    </div>
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
  const routeEvents = routes.reduce((total, route) => total + route.trainCount, 0);
  const stationEvents = stations.reduce((total, station) => total + station.totalEvents, 0);
  const weightedRouteDelay =
    routeEvents > 0
      ? routes.reduce((total, route) => total + route.avgLateMinutes * route.trainCount, 0) /
        routeEvents
      : 0;
  const weightedRouteOnTime =
    routeEvents > 0
      ? routes.reduce((total, route) => total + route.onTimePct * route.trainCount, 0) / routeEvents
      : 0;
  const worstRoute = routes[0];
  const worstStation = stations[0];
  const routeImpact = [...routes]
    .map((route) => ({ ...route, impact: impactMinutes(route.avgLateMinutes, route.trainCount) }))
    .sort((a, b) => b.impact - a.impact)
    .slice(0, 10);
  const stationImpact = [...stations]
    .map((station) => ({
      ...station,
      impact: impactMinutes(station.avgLateMinutes, station.totalEvents),
    }))
    .sort((a, b) => b.impact - a.impact)
    .slice(0, 10);
  const maxRouteImpact = routeImpact[0]?.impact ?? 0;
  const maxStationImpact = stationImpact[0]?.impact ?? 0;

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
          <div className="rounded-lg border border-[var(--rail-border)] bg-[var(--rail-surface)] px-4 py-3 text-sm">
            <div className="text-xs uppercase text-[var(--rail-muted)]">24h route sample</div>
            <div className="mt-1 text-white">
              <span className="font-semibold">{routeEvents.toLocaleString()}</span> train reads ·{" "}
              <span className="font-semibold">{formatPct(weightedRouteOnTime)}</span> within 5m
            </div>
          </div>
        </div>

        <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <MetricTile
            label="Worst route"
            value={worstRoute ? `+${worstRoute.avgLateMinutes.toFixed(1)}m` : "-"}
            detail={
              worstRoute
                ? `${worstRoute.origin} to ${worstRoute.destination}`
                : "No route sample yet"
            }
            tone="text-[var(--rail-red)]"
          />
          <MetricTile
            label="Worst station"
            value={worstStation ? `+${worstStation.avgLateMinutes.toFixed(1)}m` : "-"}
            detail={
              worstStation
                ? `${worstStation.stationDesc} · ${formatPct(worstStation.onTimePct)} within 5m`
                : "No station sample yet"
            }
            tone="text-[var(--rail-orange)]"
          />
          <MetricTile
            label="Network drag"
            value={`+${weightedRouteDelay.toFixed(1)}m`}
            detail={`${delayedRoutes} delayed routes · ${delayedStations} pressured stations`}
            tone="text-[var(--rail-yellow)]"
          />
          <MetricTile
            label="Observed stops"
            value={stationEvents.toLocaleString()}
            detail={`${routes.length} routes · ${stations.length} stations ranked`}
          />
        </section>

        <CountryBoard limit={120} minutes={60} />

        <section className="grid gap-5 xl:grid-cols-2">
          <div className="overflow-hidden rounded-lg border border-[var(--rail-border)] bg-[var(--rail-surface)]">
            <div className="border-b border-[var(--rail-border)] px-4 py-3">
              <p className="text-xs font-semibold uppercase text-[var(--rail-green)]">Delay load</p>
              <h2 className="text-lg font-semibold text-white">Network pressure by hour</h2>
            </div>
            <div className="px-2 py-4">
              <DelayChart hours={24} />
            </div>
          </div>

          <div className="overflow-hidden rounded-lg border border-[var(--rail-border)] bg-[var(--rail-surface)]">
            <div className="border-b border-[var(--rail-border)] px-4 py-3">
              <p className="text-xs font-semibold uppercase text-[var(--rail-green)]">Stations</p>
              <h2 className="text-lg font-semibold text-white">Where delays concentrate</h2>
            </div>
            <div className="px-2 py-4">
              <StationRiskChart />
            </div>
          </div>
        </section>

        <section className="overflow-hidden rounded-lg border border-[var(--rail-border)] bg-[var(--rail-surface)]">
          <div className="border-b border-[var(--rail-border)] px-4 py-3">
            <p className="text-xs font-semibold uppercase text-[var(--rail-green)]">Routes</p>
            <h2 className="text-lg font-semibold text-white">Reliability against delay</h2>
          </div>
          <div className="px-2 py-4">
            <RouteReliabilityChart />
          </div>
        </section>

        <section className="grid gap-5 xl:grid-cols-2">
          <div className="overflow-hidden rounded-lg border border-[var(--rail-border)] bg-[var(--rail-surface)]">
            <div className="border-b border-[var(--rail-border)] px-4 py-3">
              <p className="text-xs font-semibold uppercase text-[var(--rail-green)]">Routes</p>
              <h2 className="text-lg font-semibold text-white">Highest passenger disruption</h2>
            </div>
            <div className="overflow-auto">
              <table className="w-full min-w-[660px] text-sm">
                <thead>
                  <tr className="border-b border-[var(--rail-border)] text-left text-xs font-semibold uppercase text-[var(--rail-muted)]">
                    <th className="px-3 py-2">Route</th>
                    <th className="px-3 py-2">Avg</th>
                    <th className="px-3 py-2">Within 5m</th>
                    <th className="px-3 py-2">Trains</th>
                    <th className="px-3 py-2">Delay load</th>
                  </tr>
                </thead>
                <tbody>
                  {routeImpact.map((route) => (
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
                      <td className="px-3 py-3">
                        <div className="flex min-w-36 items-center gap-2">
                          <BarMeter value={route.impact} max={maxRouteImpact} tone="bg-red-500" />
                          <span className="w-14 text-right text-xs text-[var(--rail-muted)]">
                            {Math.round(route.impact)}m
                          </span>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {routes.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-3 py-8 text-center text-[var(--rail-muted)]">
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
              <h2 className="text-lg font-semibold text-white">Station pressure by delay load</h2>
            </div>
            <div className="overflow-auto">
              <table className="w-full min-w-[660px] text-sm">
                <thead>
                  <tr className="border-b border-[var(--rail-border)] text-left text-xs font-semibold uppercase text-[var(--rail-muted)]">
                    <th className="px-3 py-2">Station</th>
                    <th className="px-3 py-2">Avg</th>
                    <th className="px-3 py-2">Worst</th>
                    <th className="px-3 py-2">Events</th>
                    <th className="px-3 py-2">Delay load</th>
                  </tr>
                </thead>
                <tbody>
                  {stationImpact.map((station) => (
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
                      <td className="px-3 py-3">
                        <div className="flex min-w-36 items-center gap-2">
                          <BarMeter
                            value={station.impact}
                            max={maxStationImpact}
                            tone="bg-orange-500"
                          />
                          <span className="w-14 text-right text-xs text-[var(--rail-muted)]">
                            {Math.round(station.impact)}m
                          </span>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {stations.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-3 py-8 text-center text-[var(--rail-muted)]">
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
