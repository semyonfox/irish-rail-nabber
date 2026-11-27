import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import BusAttribution from "../components/BusAttribution";
import RequestError from "../components/RequestError";
import { Card, Empty, Icon, PageHeader, SearchInput } from "../components/ui";
import { BUS_ROUTES } from "../graphql/queries";
import { busRoutePath, type BusRoute } from "../utils/busHistory";
import { usePollingQuery } from "../utils/usePollingQuery";

const LIMIT = 200;

export default function BusRoutes() {
  const [params, setParams] = useSearchParams();
  const search = params.get("q") ?? "";
  const [input, setInput] = useState(search);

  useEffect(() => {
    const timer = setTimeout(() => {
      const next = input.trim();
      if (next !== search) setParams(next ? { q: next } : {}, { replace: true });
    }, 250);
    return () => clearTimeout(timer);
  }, [input, search, setParams]);

  const [{ data, fetching, error }, retry] = usePollingQuery<{ busRoutes: BusRoute[] }>({
    query: BUS_ROUTES,
    variables: { search: search || null, limit: LIMIT },
  });
  const routes = data?.busRoutes ?? [];

  return (
    <div className="page">
      <div className="page-inner">
        <PageHeader
          eyebrow="Routes"
          title={
            <>
              Find a bus <em>route</em>
            </>
          }
          description="Search route numbers, destinations and operators, including services that publish a timetable only."
        />
        <Card
          title="Bus routes"
          description="Select a route for current stop delays and recorded history."
        >
          <div className="bus-search-wrap">
            <SearchInput
              value={input}
              onChange={setInput}
              label="Search bus routes"
              placeholder="409, Salthill or Dublin Bus"
              className="w-full"
            />
            <span role="status">
              {fetching
                ? "Searching…"
                : routes.length === LIMIT
                  ? `${LIMIT} shown. Refine the search to find more.`
                  : `${routes.length} shown`}
            </span>
          </div>
          {error && (
            <RequestError
              bare
              error={error}
              onRetry={() => retry({ requestPolicy: "network-only" })}
              title="Route search unavailable"
            />
          )}
          <div className="bus-stop-list" aria-busy={fetching}>
            {routes.map((route) => (
              <Link
                className="bus-stop-option"
                key={`${route.feedVersionId}:${route.routeId}`}
                to={busRoutePath(route.feedVersionId, route.routeId)}
              >
                <span className="bus-route-chip">{route.routeShortName || "Bus"}</span>
                <span>
                  <strong>{route.routeLongName || route.routeId}</strong>
                  <small>{route.operatorName || "Unknown operator"}</small>
                </span>
                <Icon name="arrow" />
              </Link>
            ))}
            {!fetching && !error && routes.length === 0 ? (
              <Empty className="!min-h-40">
                {search
                  ? `No bus routes match "${search}".`
                  : "No bus schedule has been imported yet."}
              </Empty>
            ) : null}
          </div>
        </Card>
        <BusAttribution />
      </div>
    </div>
  );
}
