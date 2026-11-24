import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import RequestError from "../components/RequestError";
import { Card, Empty, Kpi, PageHeader, Segmented } from "../components/ui";
import { BUS_PUBLISHED_DATASET, BUS_PUBLISHED_PERFORMANCE } from "../graphql/queries";
import {
  isBusPublishedDatasetData,
  isBusPublishedPageData,
  publishedRoutePath,
  type BusPublishedDataset,
} from "../utils/busPublished";
import { useCachedBusQuery } from "../utils/useCachedBusQuery";
import { CHART, CHART_TOOLTIP_STYLE } from "../utils/format";

const pageSize = 200;
const decimal = (value: number | null, unit = "") =>
  value === null ? "—" : value.toLocaleString("en-IE", { maximumFractionDigits: 2 }) + unit;
const metricOptions = [
  { value: "onTimePct", label: "On time %" },
  { value: "excessWaitMinutes", label: "Excess wait" },
  { value: "lostKm", label: "Lost kilometres" },
] as const;
type Metric = (typeof metricOptions)[number]["value"];

function PublishedRecords({ dataset }: { dataset: BusPublishedDataset }) {
  const [params, setParams] = useSearchParams();
  const query = params.get("q") ?? "";
  const [draft, setDraft] = useState(query);
  const [chosenMetric, setMetric] = useState<Metric>();
  const operatorName = params.get("operator") || undefined;
  const routeShortName = params.get("route") || undefined;
  const yearValue = Number(params.get("year"));
  const year = dataset.years.includes(yearValue) ? yearValue : undefined;
  const rawOffset = Number(params.get("offset"));
  const offset =
    Number.isSafeInteger(rawOffset) && rawOffset > 0 ? Math.min(rawOffset, 100_000) : 0;
  useEffect(() => setDraft(query), [query]);
  useEffect(() => {
    if (draft === query) return;
    const timer = setTimeout(
      () =>
        setParams(
          (previous) => {
            const next = new URLSearchParams(previous);
            if (draft) next.set("q", draft);
            else next.delete("q");
            next.delete("offset");
            next.delete("route");
            return next;
          },
          { replace: true },
        ),
      250,
    );
    return () => clearTimeout(timer);
  }, [draft, query, setParams]);
  const change = (name: string, value: string) =>
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      if (value) next.set(name, value);
      else next.delete(name);
      if (name !== "offset") next.delete("offset");
      return next;
    });
  const result = useCachedBusQuery({
    query: BUS_PUBLISHED_PERFORMANCE,
    variables: {
      importId: dataset.importId,
      search: query || undefined,
      operatorName,
      routeShortName,
      year,
      offset,
      limit: pageSize,
    },
    validate: isBusPublishedPageData,
    pollInterval: 900_000,
  });
  const rows = result.data?.busPublishedPerformance.rows ?? [];
  useEffect(() => setMetric(undefined), [operatorName, routeShortName]);
  const metric =
    chosenMetric ??
    (rows.some((row) => row.onTimePct !== null)
      ? "onTimePct"
      : rows.some((row) => row.excessWaitMinutes !== null)
        ? "excessWaitMinutes"
        : "lostKm");

  const total = result.data?.busPublishedPerformance.totalCount ?? 0;
  const chart = rows
    .slice()
    .reverse()
    .map((row) => ({
      period: `${row.reportYear} P${row.reportPeriod}`,
      value: row[metric],
    }));
  const oneRoute = !!operatorName && !!routeShortName;
  return (
    <>
      <Card
        title={oneRoute ? `Route ${routeShortName} · ${operatorName}` : "Search published records"}
        description="Reporting periods P1–P13 are retained as NTA publishes them. Select a route to see its trend."
      >
        <div className="card-body flex flex-wrap items-end gap-4">
          <label className="grid gap-1 text-sm">
            Route or contract
            <input
              className="input"
              aria-label="Search published routes"
              placeholder="409, Dublin Bus…"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
          </label>
          <label className="grid gap-1 text-sm">
            Contract
            <select
              className="input"
              aria-label="Published contract"
              value={operatorName ?? ""}
              onChange={(event) => change("operator", event.target.value)}
            >
              <option value="">All contracts</option>
              {dataset.operators.map((operator) => (
                <option key={operator}>{operator}</option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            Year
            <select
              className="input"
              aria-label="Published year"
              value={year ?? ""}
              onChange={(event) => change("year", event.target.value)}
            >
              <option value="">All years</option>
              {dataset.years.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          {routeShortName && (
            <button className="text-sm underline" onClick={() => change("route", "")}>
              Show all routes
            </button>
          )}
          <span className="text-xs text-muted" role="status">
            {result.cached
              ? "Saved on this device"
              : result.fetching
                ? "Loading published records…"
                : `${total.toLocaleString()} records`}
          </span>
        </div>
        {result.error && (
          <RequestError
            error={result.error}
            onRetry={result.retry}
            title="Published records could not refresh"
          />
        )}
      </Card>
      {oneRoute && rows.length > 0 && (
        <Card
          title="Published route trend"
          description="On-time departures, extra passenger waiting time and kilometres not operated use different units."
        >
          <div className="card-body grid gap-4">
            <Segmented
              label="Published performance metric"
              options={[...metricOptions]}
              value={metric}
              onChange={setMetric}
            />
            {chart.some((point) => point.value !== null) ? (
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={chart} margin={{ left: 0, right: 20, top: 10, bottom: 0 }}>
                  <CartesianGrid stroke={CHART.grid} vertical={false} />
                  <XAxis dataKey="period" stroke={CHART.axis} fontSize={11} minTickGap={35} />
                  <YAxis
                    stroke={CHART.axis}
                    fontSize={11}
                    unit={metric === "onTimePct" ? "%" : metric === "excessWaitMinutes" ? "m" : ""}
                  />
                  <Tooltip
                    contentStyle={CHART_TOOLTIP_STYLE}
                    formatter={(value) =>
                      decimal(
                        Number(value),
                        metric === "onTimePct"
                          ? "%"
                          : metric === "excessWaitMinutes"
                            ? " min"
                            : " km",
                      )
                    }
                  />
                  <Line
                    dataKey="value"
                    name={metricOptions.find((option) => option.value === metric)?.label}
                    stroke={CHART.series1}
                    dot={false}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <Empty>This metric was not published for the selected route and periods.</Empty>
            )}
          </div>
        </Card>
      )}
      <Card
        title="Historical performance"
        description="A dash means the metric was not available. EWT measures passenger waiting time beyond the scheduled wait; it is not a bus's delay."
      >
        <div className="overflow-auto max-h-[42rem]">
          <table className="data-table min-w-[1100px]">
            <thead>
              <tr>
                <th>Route / contract</th>
                <th>Period</th>
                <th className="num">On time</th>
                <th className="num">Early</th>
                <th className="num">Late</th>
                <th className="num">Departures</th>
                <th className="num">Excess wait</th>
                <th className="num">Planned km</th>
                <th className="num">Operated km</th>
                <th className="num">Lost km</th>
                <th className="num">Deductible lost km</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={`${row.operatorName}:${row.routeShortName}:${row.reportYear}:${row.reportPeriod}`}
                >
                  <td>
                    <Link
                      className="block underline"
                      to={publishedRoutePath(row.operatorName, row.routeShortName)}
                    >
                      Route {row.routeShortName}
                    </Link>
                    <small className="block text-muted">{row.operatorName}</small>
                  </td>
                  <td>
                    {row.reportYear} P{row.reportPeriod}
                  </td>
                  <td className="num">{decimal(row.onTimePct, "%")}</td>
                  <td className="num">{decimal(row.earlyPct, "%")}</td>
                  <td className="num">{decimal(row.latePct, "%")}</td>
                  <td className="num">{decimal(row.actualDepartures)}</td>
                  <td className="num">{decimal(row.excessWaitMinutes, "m")}</td>
                  <td className="num">{decimal(row.plannedKm)}</td>
                  <td className="num">{decimal(row.actualKm)}</td>
                  <td className="num">{decimal(row.lostKm)}</td>
                  <td className="num">{decimal(row.contractualLostKm)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!result.fetching && !rows.length && (
          <Empty>No published records match this selection.</Empty>
        )}
        <div className="card-body flex items-center justify-between gap-3 text-sm">
          <button
            disabled={offset === 0 || result.fetching}
            onClick={() => change("offset", String(Math.max(0, offset - pageSize)))}
            className="underline disabled:opacity-40"
          >
            Previous
          </button>
          <span>
            {rows.length
              ? `${offset + 1}–${offset + rows.length} of ${total.toLocaleString()}`
              : "0 records"}
          </span>
          <button
            disabled={offset + pageSize >= total || result.fetching}
            onClick={() => change("offset", String(offset + pageSize))}
            className="underline disabled:opacity-40"
          >
            Next
          </button>
        </div>
      </Card>
    </>
  );
}

export default function BusPublished() {
  const result = useCachedBusQuery({
    query: BUS_PUBLISHED_DATASET,
    variables: {},
    validate: isBusPublishedDatasetData,
    pollInterval: 900_000,
  });
  const dataset = result.data?.busPublishedDataset;
  return (
    <div className="page">
      <div className="page-inner">
        <Link to="/buses/history" className="text-sm underline">
          ← Collected bus history
        </Link>
        <PageHeader
          eyebrow="Public records · National Transport Authority"
          title={
            <>
              Published bus <em>performance</em>
            </>
          }
          description="Historical PSO contract and route statistics imported from NTA's public dashboard."
        />
        {result.error && (
          <RequestError
            error={result.error}
            onRetry={result.retry}
            title="Published dataset could not refresh"
          />
        )}
        {dataset ? (
          <>
            <div className="grid gap-4 sm:grid-cols-3">
              <Kpi
                label="Reporting years"
                value={`${dataset.firstYear}–${dataset.lastYear}`}
                detail="Coverage varies by route and metric"
              />
              <Kpi label="Routes within contracts" value={dataset.routeCount.toLocaleString()} />
              <Kpi
                label="Route-period records"
                value={dataset.recordCount.toLocaleString()}
                detail="Published aggregates, not realtime samples"
              />
            </div>
            <p className="text-sm text-muted">
              <a href={dataset.sourceUrl} target="_blank" rel="noreferrer" className="underline">
                View the original NTA dashboard
              </a>
              {dataset.sourceUpdatedAt
                ? ` · Source updated ${dataset.sourceUpdatedAt.slice(0, 10)}`
                : ""}
              {` · Imported ${dataset.importedAt.slice(0, 10)}`}. NTA punctuality allows departures
              up to one minute early or five minutes and 59 seconds late. These published measures
              remain separate from our live prediction statistics.
            </p>
            <PublishedRecords key={dataset.importId} dataset={dataset} />
          </>
        ) : !result.fetching && !result.error ? (
          <Empty>No published history has been imported yet.</Empty>
        ) : null}
      </div>
    </div>
  );
}
