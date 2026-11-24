import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Card, Empty, PageHeader, SearchInput } from "../components/ui";
import RequestError from "../components/RequestError";
import { BUS_ROUTES } from "../graphql/queries";
import { busRoutePath, isBusRoutesData } from "../utils/busHistory";
import { useCachedBusQuery } from "../utils/useCachedBusQuery";

export default function BusRoutes() {
  const [params, setParams] = useSearchParams();
  const search = params.get("q") ?? "";
  const [input, setInput] = useState(search);
  useEffect(() => setInput(search), [search]);
  useEffect(() => {
    const timer = setTimeout(() => {
      if (input !== search) setParams(input.trim() ? { q: input.trim() } : {}, { replace: true });
    }, 250);
    return () => clearTimeout(timer);
  }, [input, search, setParams]);
  const { data, fetching, error, cached, retry } = useCachedBusQuery({
    query: BUS_ROUTES,
    variables: { search: search || null, limit: 200 },
    validate: isBusRoutesData,
    pollInterval: 900_000,
  });
  return (
    <div className="page">
      <div className="page-inner">
        <PageHeader
          eyebrow="Buses"
          title={
            <>
              Find your <em>route</em>
            </>
          }
          description="Search route numbers, destinations and operators, including timetable-only services."
        />
        <Card title="Bus routes" description="Select a route for stop delays and recorded history.">
          <div className="card-body grid gap-4">
            <SearchInput
              value={input}
              onChange={setInput}
              label="Search bus routes"
              placeholder="409, Galway, Dublin Bus…"
              className="w-full"
            />
            <p className="text-xs text-muted" role="status">
              {fetching ? "Updating routes…" : `${data?.busRoutes.length ?? 0} routes shown`}
              {cached ? " · saved on this device" : ""}
              {data?.busRoutes.length === 200 ? " · refine your search to find more" : ""}
            </p>
          </div>
          {error && (
            <RequestError error={error} onRetry={retry} title="Route search could not refresh" />
          )}
          <div className="bus-stop-list" aria-busy={fetching}>
            {(data?.busRoutes ?? []).map((route) => (
              <Link
                className="bus-stop-option"
                key={`${route.feedVersionId}:${route.routeId}`}
                to={busRoutePath(route)}
              >
                <span className="bus-route-chip">{route.routeShortName || "Bus"}</span>
                <span>
                  <strong>{route.routeLongName || route.routeId}</strong>
                  <small>{route.operatorName || "Unknown operator"}</small>
                </span>
                <span aria-hidden="true">→</span>
              </Link>
            ))}
            {!fetching && !data?.busRoutes.length && !error && (
              <Empty>
                {search ? `No routes match "${search}".` : "No bus schedule has been imported yet."}
              </Empty>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
