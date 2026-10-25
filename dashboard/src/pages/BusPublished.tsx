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
import { Card, Empty, Kpi, PageHeader, SearchInput, Segmented } from "../components/ui";
import { BUS_PUBLISHED_DATASET, BUS_PUBLISHED_PERFORMANCE } from "../graphql/queries";
import {
  NTA_PUBLISHED_DASHBOARD_URL,
  defaultPublishedMetric,
  publishedContractPath,
  type BusPublishedDataset,
  type BusPublishedPoint,
  type PublishedMetric,
} from "../utils/busPublished";
import { CHART, CHART_TOOLTIP_STYLE } from "../utils/format";
import { usePollingQuery } from "../utils/usePollingQuery";

const PAGE_SIZE = 200;

const metricOptions: { value: PublishedMetric; label: string; unit: string }[] = [
  { value: "onTimePct", label: "On time", unit: "%" },
  { value: "excessWaitMinutes", label: "Excess wait", unit: " min" },
  { value: "lostKm", label: "Lost km", unit: " km" },
];

function decimal(value: number | null, unit = "") {
  return value === null
    ? "—"
    : `${value.toLocaleString("en-IE", { maximumFractionDigits: 2 })}${unit}`;
}

function PublishedRecords({ dataset }: { dataset: BusPublishedDataset }) {
  const [params, setParams] = useSearchParams();
  const search = params.get("q") ?? "";
  const [input, setInput] = useState(search);
  const [chosenMetric, setMetric] = useState<PublishedMetric>();
  const operatorName = params.get("operator") || undefined;
  const routeShortName = params.get("route") || undefined;
  const yearParam = Number(params.get("year"));
  const year = dataset.years.includes(yearParam) ? yearParam : undefined;
  const offsetParam = Number(params.get("offset"));
  const offset = Number.isSafeInteger(offsetParam) && offsetParam > 0 ? offsetParam : 0;

  // any filter change starts again from the first page
  const update = (changes: Record<string, string | undefined>) =>
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        for (const [name, value] of Object.entries(changes)) {
          if (value) next.set(name, value);
          else next.delete(name);
        }
        if (!("offset" in changes)) next.delete("offset");
        return next;
      },
      { replace: true },
    );

  useEffect(() => {
    const timer = setTimeout(() => {
      const next = input.trim();
      if (next === search) return;
      setParams(
        (previous) => {
          const params = new URLSearchParams(previous);
          if (next) params.set("q", next);
          else params.delete("q");
          params.delete("route");
          params.delete("offset");
          return params;
        },
        { replace: true },
      );
    }, 250);
    return () => clearTimeout(timer);
  }, [input, search, setParams]);

  const [{ data, fetching, error }, retry] = usePollingQuery<{
    busPublishedPerformance: { totalCount: number; rows: BusPublishedPoint[] };
  }>({
    query: BUS_PUBLISHED_PERFORMANCE,
    variables: {
      importId: dataset.importId,
      search: search || null,
      operatorName: operatorName ?? null,
      routeShortName: routeShortName ?? null,
      year: year ?? null,
      limit: PAGE_SIZE,
      offset,
    },
  });
  const rows = data?.busPublishedPerformance.rows ?? [];
  const total = data?.busPublishedPerformance.totalCount ?? 0;
  const oneRoute = operatorName !== undefined && routeShortName !== undefined;
  const metric = chosenMetric ?? defaultPublishedMetric(rows);
  const unit = metricOptions.find((option) => option.value === metric)?.unit ?? "";
  const chart = rows.toReversed().map((row) => ({
    period: `${row.reportYear} P${row.reportPeriod}`,
    value: row[metric],
  }));

  return (
    <>
      <Card
        title={oneRoute ? `Route ${routeShortName} · ${operatorName}` : "Search published records"}
        description="Reporting periods P1 to P13 are kept as the NTA publishes them. Select a route to see its trend."
      >
        <div className="card-body flex flex-wrap items-end gap-4">
          <div className="w-full min-w-0 sm:w-64">
            <span className="field-label">Route or contract</span>
            <SearchInput
              value={input}
              onChange={setInput}
              label="Search published routes"
              placeholder="409 or Dublin Bus"
              className="w-full"
            />
          </div>
          <div className="w-full min-w-0 sm:w-56">
            <label className="field-label" htmlFor="published-operator">
              Contract
            </label>
            <select
              id="published-operator"
              className="control w-full"
              value={operatorName ?? ""}
              onChange={(event) => update({ operator: event.target.value })}
            >
              <option value="">All contracts</option>
              {dataset.operators.map((operator) => (
                <option key={operator}>{operator}</option>
              ))}
            </select>
          </div>
          <div className="w-full min-w-0 sm:w-36">
            <label className="field-label" htmlFor="published-year">
              Year
            </label>
            <select
              id="published-year"
              className="control w-full"
              value={year ?? ""}
              onChange={(event) => update({ year: event.target.value })}
            >
              <option value="">All years</option>
              {dataset.years.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </div>
          {routeShortName ? (
            <button type="button" className="btn" onClick={() => update({ route: undefined })}>
              Show all routes
            </button>
          ) : null}
          <span className="text-xs text-muted" role="status">
            {fetching ? "Loading published records…" : `${total.toLocaleString()} records`}
          </span>
        </div>
        {error && (
          <RequestError
            bare
            error={error}
            onRetry={() => retry({ requestPolicy: "network-only" })}
            title="Published records unavailable"
          />
        )}
      </Card>

      {oneRoute && rows.length > 0 && (
        <Card
          title="Route trend"
          description="On-time departures, extra passenger waiting time and kilometres not operated use different units."
        >
          <div className="card-body grid gap-4">
            <Segmented
              label="Published performance metric"
              options={metricOptions}
              value={metric}
              onChange={setMetric}
            />
            {chart.some((point) => point.value !== null) ? (
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={chart} margin={{ left: 0, right: 20, top: 10, bottom: 0 }}>
                  <CartesianGrid stroke={CHART.grid} vertical={false} />
                  <XAxis dataKey="period" stroke={CHART.axis} fontSize={11} minTickGap={35} />
                  <YAxis stroke={CHART.axis} fontSize={11} unit={unit.trim()} />
                  <Tooltip
                    contentStyle={CHART_TOOLTIP_STYLE}
                    formatter={(value) => decimal(Number(value), unit)}
                  />
                  <Line
                    dataKey="value"
                    name={metricOptions.find((option) => option.value === metric)?.label}
                    stroke={CHART.series1}
                    dot={false}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <Empty>This metric was not published for the selected route.</Empty>
            )}
          </div>
        </Card>
      )}

      <Card
        title="Published performance"
        description="A dash means the NTA did not publish that metric. Excess wait is passenger waiting time beyond the scheduled wait, not a bus's delay."
      >
        {rows.length > 0 ? (
          <div className="max-h-[42rem] overflow-auto">
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
                        className="cell-main block underline"
                        to={publishedContractPath(row.operatorName, row.routeShortName)}
                      >
                        Route {row.routeShortName}
                      </Link>
                      <small className="block text-muted">{row.operatorName}</small>
                    </td>
                    <td className="whitespace-nowrap">
                      {row.reportYear} P{row.reportPeriod}
                    </td>
                    <td className="num">{decimal(row.onTimePct, "%")}</td>
                    <td className="num">{decimal(row.earlyPct, "%")}</td>
                    <td className="num">{decimal(row.latePct, "%")}</td>
                    <td className="num">{decimal(row.actualDepartures)}</td>
                    <td className="num">{decimal(row.excessWaitMinutes, " min")}</td>
                    <td className="num">{decimal(row.plannedKm)}</td>
                    <td className="num">{decimal(row.actualKm)}</td>
                    <td className="num">{decimal(row.lostKm)}</td>
                    <td className="num">{decimal(row.contractualLostKm)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : !fetching && !error ? (
          <Empty>No published records match this selection.</Empty>
        ) : null}
        {total > PAGE_SIZE && (
          <div className="card-body flex items-center justify-between gap-3 text-sm">
            <button
              type="button"
              className="btn"
              disabled={offset === 0 || fetching}
              onClick={() => update({ offset: String(Math.max(0, offset - PAGE_SIZE)) })}
            >
              Previous
            </button>
            <span>
              {offset + 1} to {offset + rows.length} of {total.toLocaleString()}
            </span>
            <button
              type="button"
              className="btn"
              disabled={offset + PAGE_SIZE >= total || fetching}
              onClick={() => update({ offset: String(offset + PAGE_SIZE) })}
            >
              Next
            </button>
          </div>
        )}
      </Card>
    </>
  );
}

export default function BusPublished() {
  const [{ data, fetching, error }, retry] = usePollingQuery<{
    busPublishedDataset: BusPublishedDataset | null;
  }>({ query: BUS_PUBLISHED_DATASET });
  const dataset = data?.busPublishedDataset;

  return (
    <div className="page">
      <div className="page-inner">
        <Link to="/buses/history" className="text-sm underline">
          ← Collected bus history
        </Link>
        <PageHeader
          eyebrow="NTA published records"
          title={
            <>
              Published bus <em>performance</em>
            </>
          }
          description="Route statistics for PSO bus contracts, as reported by the National Transport Authority. Separate from the predictions this site collects."
        />
        {error && (
          <RequestError
            error={error}
            onRetry={() => retry({ requestPolicy: "network-only" })}
            title="Published records unavailable"
          />
        )}
        {dataset ? (
          <>
            <div className="grid gap-4 sm:grid-cols-3">
              <Kpi
                label="Reporting years"
                value={`${dataset.firstYear} to ${dataset.lastYear}`}
                detail="Coverage varies by route and metric"
                index={0}
              />
              <Kpi
                label="Routes within contracts"
                value={dataset.routeCount.toLocaleString()}
                index={1}
              />
              <Kpi
                label="Route-period records"
                value={dataset.recordCount.toLocaleString()}
                detail="Published aggregates, not live samples"
                index={2}
              />
            </div>
            <p className="text-sm text-muted">
              <a
                href={NTA_PUBLISHED_DASHBOARD_URL}
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                Original NTA dashboard
              </a>
              {dataset.sourceUpdatedAt
                ? `. Source updated ${dataset.sourceUpdatedAt.slice(0, 10)}`
                : ""}
              , imported {dataset.importedAt.slice(0, 10)}. NTA punctuality counts departures from
              one minute early to five minutes 59 seconds late.
            </p>
            <PublishedRecords key={dataset.importId} dataset={dataset} />
          </>
        ) : !fetching && !error ? (
          <Empty>No published records have been imported yet.</Empty>
        ) : null}
      </div>
    </div>
  );
}
