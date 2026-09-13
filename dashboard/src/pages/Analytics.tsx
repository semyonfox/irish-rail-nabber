import CountryBoard from "../components/CountryBoard";
import DelayChart from "../components/DelayChart";
import StationRiskChart from "../components/StationRiskChart";
import RequestError from "../components/RequestError";
import { Card, DelayPill, Kpi, PageHeader } from "../components/ui";
import { ROUTE_RELIABILITY, STATION_DELAY_STATS } from "../graphql/queries";
import { isAuthError } from "../utils/errors";
import { usePollingQuery } from "../utils/usePollingQuery";
import { delayTone, formatPct } from "../utils/format";

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

function impactMinutes(avgLateMinutes: number, count: number) {
  return Math.max(0, avgLateMinutes) * count;
}

function LoadMeter({ value, max }: { value: number; max: number }) {
  const width = max > 0 ? Math.max(4, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className="flex min-w-40 items-center gap-3">
      <div className="meter flex-1" data-series>
        <span style={{ width: `${width}%` }} />
      </div>
      <span className="code w-14 text-right">{Math.round(value).toLocaleString()}m</span>
    </div>
  );
}

export default function Analytics() {
  const [{ data: routeData, error: routeError }, retryRoutes] =
    usePollingQuery<RouteReliabilityData>({
      query: ROUTE_RELIABILITY,
      variables: { hours: 24, minTrains: 3 },
      pollInterval: 60000,
    });

  const [{ data: stationData, error: stationError }, retryStations] =
    usePollingQuery<StationDelayStatsData>({
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
  const statsError = !routeData && !stationData ? routeError || stationError : null;
  const authRequired = isAuthError(statsError);
  const showStats = !statsError;

  return (
    <div className="page">
      <div className="page-inner">
        <PageHeader
          eyebrow="Live network"
          title={
            <>
              How the network is <em>running</em>
            </>
          }
          description={
            showStats && routeEvents > 0
              ? `${routeEvents.toLocaleString()} train reads in the last 24 hours, ${formatPct(weightedRouteOnTime)} of them within five minutes of schedule.`
              : "Live departures and arrivals from every station board in Ireland, refreshed every 15 seconds."
          }
        />

        {statsError ? (
          <RequestError
            error={statsError}
            title="Network statistics unavailable"
            onRetry={
              authRequired
                ? undefined
                : () => {
                    retryRoutes({ requestPolicy: "network-only" });
                    retryStations({ requestPolicy: "network-only" });
                  }
            }
          />
        ) : (
          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Kpi
              index={1}
              label="Worst route"
              value={worstRoute ? `+${worstRoute.avgLateMinutes.toFixed(1)}m` : "-"}
              detail={
                worstRoute
                  ? `${worstRoute.origin} to ${worstRoute.destination}`
                  : "No route sample yet"
              }
              tone={worstRoute ? toKpiTone(worstRoute.avgLateMinutes) : undefined}
            />
            <Kpi
              index={2}
              label="Worst station"
              value={worstStation ? `+${worstStation.avgLateMinutes.toFixed(1)}m` : "-"}
              detail={
                worstStation
                  ? `${worstStation.stationDesc} · ${formatPct(worstStation.onTimePct)} within 5 min`
                  : "No station sample yet"
              }
              tone={worstStation ? toKpiTone(worstStation.avgLateMinutes) : undefined}
            />
            <Kpi
              index={3}
              label="Average delay"
              value={`+${weightedRouteDelay.toFixed(1)}m`}
              detail={`${delayedRoutes} delayed routes · ${delayedStations} pressured stations`}
              tone={toKpiTone(weightedRouteDelay)}
            />
            <Kpi
              index={4}
              label="Observed stops"
              value={stationEvents.toLocaleString()}
              detail={`${routes.length} routes and ${stations.length} stations ranked`}
            />
          </section>
        )}

        <CountryBoard limit={120} minutes={60} index={5} />

        {showStats ? (
          <>
            <section className="grid gap-4 xl:grid-cols-2">
              <Card
                index={6}
                title="Delay through the day"
                description="Weighted average and worst stop, last 24 hours"
              >
                <div className="card-body">
                  <DelayChart hours={24} />
                </div>
              </Card>
              <Card
                index={7}
                title="Where delays concentrate"
                description="Stations with the highest average delay, last 24 hours"
              >
                <div className="card-body">
                  <StationRiskChart />
                </div>
              </Card>
            </section>

            <section className="grid gap-4 xl:grid-cols-2">
              <Card
                index={8}
                title="Routes"
                description="Ranked by delay load: average delay × trains"
              >
                <div className="overflow-auto">
                  <table className="data-table min-w-[640px]">
                    <thead>
                      <tr>
                        <th>Route</th>
                        <th>Average</th>
                        <th className="num">Within 5m</th>
                        <th className="num">Trains</th>
                        <th>Delay load</th>
                      </tr>
                    </thead>
                    <tbody>
                      {routeImpact.map((route) => (
                        <tr key={`${route.origin}-${route.destination}`}>
                          <td>
                            <div className="cell-main">{route.origin}</div>
                            <div className="cell-sub">to {route.destination}</div>
                          </td>
                          <td>
                            <DelayPill minutes={route.avgLateMinutes} precise />
                          </td>
                          <td className="num">{formatPct(route.onTimePct)}</td>
                          <td className="num text-muted">{route.trainCount}</td>
                          <td>
                            <LoadMeter value={route.impact} max={maxRouteImpact} />
                          </td>
                        </tr>
                      ))}
                      {routes.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="py-10 text-center text-muted">
                            No route reliability data
                          </td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
              </Card>

              <Card
                index={9}
                title="Stations"
                description="Ranked by delay load: average delay × stops"
              >
                <div className="overflow-auto">
                  <table className="data-table min-w-[640px]">
                    <thead>
                      <tr>
                        <th>Station</th>
                        <th>Average</th>
                        <th className="num">Worst</th>
                        <th className="num">Stops</th>
                        <th>Delay load</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stationImpact.map((station) => (
                        <tr key={station.stationCode}>
                          <td>
                            <div className="cell-main">{station.stationDesc}</div>
                            <div className="cell-sub">
                              {formatPct(station.onTimePct)} within 5 min
                            </div>
                          </td>
                          <td>
                            <DelayPill minutes={station.avgLateMinutes} precise />
                          </td>
                          <td className="num">+{station.maxLateMinutes}m</td>
                          <td className="num text-muted">{station.totalEvents.toLocaleString()}</td>
                          <td>
                            <LoadMeter value={station.impact} max={maxStationImpact} />
                          </td>
                        </tr>
                      ))}
                      {stations.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="py-10 text-center text-muted">
                            No station delay data
                          </td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
              </Card>
            </section>
          </>
        ) : null}
      </div>
    </div>
  );
}

function toKpiTone(minutes: number) {
  const tone = delayTone(minutes);
  return tone === "neutral" || tone === "muted" ? undefined : tone;
}
