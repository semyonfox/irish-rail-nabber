import { useEffect, useMemo, useState } from "react";
import { useQuery } from "urql";

import BusAttribution from "../components/BusAttribution";
import DelayStretchMap from "../components/DelayStretchMap";
import { Empty, Segmented } from "../components/ui";
import {
  DELAY_STRETCHES,
  RAIL_DWELL_HOTSPOTS,
  SERVICE_ALERT,
  SERVICE_ALERTS,
  readAlerts,
  readAlertDetail,
  readDwell,
  readStretches,
  statusLabels,
  type AlertSummary,
  type InsightsMode,
  type InsightsRange,
} from "../graphql/insights";

const DAY = 86_400_000;
const dateFormat = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Dublin" });
const noticeTime = new Intl.DateTimeFormat("en-IE", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/Dublin",
});
const numberFormat = new Intl.NumberFormat("en-IE", { maximumFractionDigits: 1 });
const modes: { value: InsightsMode; label: string }[] = [
  { value: "RAIL", label: "Rail" },
  { value: "BUS", label: "Bus" },
];
const categories = [
  "accessibility",
  "booking",
  "capacity",
  "delay",
  "disruption",
  "diversion",
  "stop_change",
  "timetable",
  "works",
  "other",
];
const impactCategories = new Set(["delay", "disruption", "works"]);
const bands = [
  { label: "All day", start: 0, end: 24 },
  { label: "AM peak · 07:00–10:00", start: 7, end: 10 },
  { label: "PM peak · 16:00–19:00", start: 16, end: 19 },
];

function recentDates(): InsightsRange {
  const to = dateFormat.format(new Date());
  const from = new Date(Date.parse(to) - 6 * DAY).toISOString().slice(0, 10);
  return { from, to };
}

function validRange(range: InsightsRange, maxDays: number) {
  const days = (Date.parse(range.to) - Date.parse(range.from)) / DAY;
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(range.from) &&
    /^\d{4}-\d{2}-\d{2}$/.test(range.to) &&
    days >= 0 &&
    days < maxDays
  );
}

function useSettledFilters(key: string) {
  const [settled, setSettled] = useState(key);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(key), 350);
    return () => window.clearTimeout(timer);
  }, [key]);
  return key === settled;
}

function medianBucket(lower: number | null, upper: number | null) {
  if (lower === null) return upper === null ? "—" : `Under ${upper} s`;
  if (upper === null) return `${lower} s or more`;
  return `${lower} to <${upper} s`;
}

function impactWindowLabel(alert: AlertSummary, end: string) {
  if (
    alert.startsAt &&
    Date.parse(end) - Date.parse(alert.startsAt) === DAY &&
    (!alert.endsAt || Date.parse(end) < Date.parse(alert.endsAt))
  ) {
    return "First 24 h of notice";
  }
  return `During notice (until ${noticeTime.format(new Date(end))})`;
}

function valueWithUnit(value: number | null, unit: string) {
  return value === null ? "—" : `${numberFormat.format(value)}${unit}`;
}

function labelCategory(value: string) {
  return value.slice(0, 1).toUpperCase() + value.slice(1).replaceAll("_", " ");
}

function DateControls({
  range,
  onChange,
  descriptionId,
}: {
  range: InsightsRange;
  onChange: (range: InsightsRange) => void;
  descriptionId?: string;
}) {
  return (
    <>
      <label className="grid min-w-0 gap-1">
        From
        <input
          className="control w-full"
          type="date"
          aria-describedby={descriptionId}
          value={range.from}
          onChange={(event) => onChange({ ...range, from: event.target.value })}
        />
      </label>
      <label className="grid min-w-0 gap-1">
        To
        <input
          className="control w-full"
          type="date"
          aria-describedby={descriptionId}
          value={range.to}
          onChange={(event) => onChange({ ...range, to: event.target.value })}
        />
      </label>
    </>
  );
}

function RangeMessage({ maxDays }: { maxDays: number }) {
  return (
    <p role="status" className="text-sm text-ink-2">
      Choose a date range of 1 to {maxDays} days.
    </p>
  );
}

function InsightsError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-3 p-4" role="alert">
      <p>Insights data could not be loaded.</p>
      <button type="button" className="btn btn-quiet" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

function AlertDetails({ alert }: { alert: AlertSummary }) {
  const { mode, alertKey, category } = alert;
  const [{ data, fetching, error }, reload] = useQuery<unknown>({
    query: SERVICE_ALERT,
    variables: { mode, alertKey },
    requestPolicy: "network-only",
  });
  const detail = readAlertDetail(data);
  if (fetching) return <Empty>Loading notice…</Empty>;
  if (detail === null && !error) return <Empty>This notice is no longer available.</Empty>;
  if (error || !detail) return <InsightsError onRetry={() => reload()} />;

  return (
    <div className="grid gap-4 border-t border-line px-4 py-4 sm:px-5">
      {detail.description ? (
        <p className="max-w-[75ch] [overflow-wrap:anywhere] whitespace-pre-line text-ink-2">
          {detail.description}
        </p>
      ) : null}
      <dl className="grid gap-2 text-sm text-ink-2 [overflow-wrap:anywhere]">
        {[
          { label: "Locations", items: detail.locationCodes },
          { label: "Corridor", items: detail.corridorCodes },
          { label: "Routes", items: detail.routes },
          { label: "Stops", items: detail.stops },
          { label: "Agency IDs", items: detail.agencyIds },
        ]
          .filter(({ items }) => items?.length)
          .map(({ label, items }) => (
            <div key={label}>
              <dt className="inline font-semibold text-ink">{label} </dt>
              <dd className="inline">{items?.join(", ")}</dd>
            </div>
          ))}
      </dl>
      {mode === "RAIL" ? (
        <section className="min-w-0 rounded-xl bg-wash p-4">
          <h3 className="font-semibold">Average lateness against baseline</h3>
          {!impactCategories.has(category) ? (
            <p className="mt-2 text-sm text-ink-2">Impact is not measured for this category.</p>
          ) : detail.neverRan ? (
            <p className="mt-2 text-sm text-ink-2">This notice never ran.</p>
          ) : detail.impactWindowEnd === null ||
            (detail.impactAvgLate === null && detail.preAvgLate === null) ? (
            <p className="mt-2 text-sm text-ink-2">
              No impact comparison available for this notice yet.
            </p>
          ) : (
            <>
              <table className="mt-2 w-full table-fixed text-left text-sm tabular-nums">
                <thead className="text-ink-2">
                  <tr>
                    <th scope="col" className="w-2/5 pr-2">
                      Window
                    </th>
                    <th scope="col" className="text-right">
                      Observed
                    </th>
                    <th scope="col" className="text-right">
                      Baseline
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <th scope="row" className="py-2 pr-2 font-medium">
                      {impactWindowLabel(alert, detail.impactWindowEnd)}
                    </th>
                    <td className="text-right">{valueWithUnit(detail.impactAvgLate, " min")}</td>
                    <td className="text-right">{valueWithUnit(detail.baselineAvgLate, " min")}</td>
                  </tr>
                  <tr>
                    <th scope="row" className="py-2 pr-2 font-medium">
                      2 hours before stated start
                    </th>
                    <td className="text-right">{valueWithUnit(detail.preAvgLate, " min")}</td>
                    <td className="text-right">
                      {valueWithUnit(detail.preBaselineAvgLate, " min")}
                    </td>
                  </tr>
                </tbody>
              </table>
              <p className="mt-2 max-w-[68ch] text-sm text-ink-2">
                Averages cover all trains at the corridor stations. Each poll of a train on a
                station board counts as one reading. Baseline uses the same hours on the previous
                four matching weekdays.
                {detail.impactEvents === null
                  ? null
                  : ` ${numberFormat.format(detail.impactEvents)} board readings in the measured notice window.`}
              </p>
            </>
          )}
        </section>
      ) : null}
    </div>
  );
}

function Alerts() {
  const [range, setRange] = useState(recentDates);
  const [mode, setMode] = useState<InsightsMode | undefined>();
  const [category, setCategory] = useState("");
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState("");
  const valid = validRange(range, 90);
  const settled = useSettledFilters(JSON.stringify([range, mode, category, page]));
  const [{ data, fetching, error }, reload] = useQuery<unknown>({
    query: SERVICE_ALERTS,
    variables: { range, mode, category: category || undefined, page },
    pause: !valid || !settled,
    requestPolicy: "network-only",
  });
  const result = readAlerts(data);

  function resetPage() {
    setPage(1);
    setExpanded("");
  }

  return (
    <>
      <div className="card grid grid-cols-2 gap-3 p-4 text-sm sm:grid-cols-4">
        <DateControls
          range={range}
          onChange={(value) => {
            setRange(value);
            resetPage();
          }}
        />
        <label className="grid min-w-0 gap-1">
          Mode
          <select
            className="control"
            value={mode ?? ""}
            onChange={(event) => {
              const value = event.target.value;
              setMode(value === "RAIL" || value === "BUS" ? value : undefined);
              resetPage();
            }}
          >
            <option value="">Rail and bus</option>
            <option value="RAIL">Rail</option>
            <option value="BUS">Bus / NTA</option>
          </select>
        </label>
        <label className="grid min-w-0 gap-1">
          Category
          <select
            className="control"
            value={category}
            onChange={(event) => {
              setCategory(event.target.value);
              resetPage();
            }}
          >
            <option value="">All categories</option>
            {categories.map((value) => (
              <option key={value} value={value}>
                {labelCategory(value)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {!valid ? (
        <RangeMessage maxDays={90} />
      ) : !settled || fetching ? (
        <Empty>Loading notices…</Empty>
      ) : error || !result ? (
        <InsightsError onRetry={() => reload()} />
      ) : result.alerts.length === 0 ? (
        <Empty>No notices match these filters.</Empty>
      ) : (
        <section aria-label="Matching notices" className="grid min-w-0 gap-3">
          {result.alerts.map((alert) => {
            const key = `${alert.mode}/${alert.alertKey}`;
            const open = expanded === key;
            return (
              <article className="card min-w-0 overflow-hidden" key={key}>
                <button
                  type="button"
                  aria-expanded={open}
                  className="grid w-full gap-2 px-4 py-4 text-left hover:bg-wash sm:px-5"
                  onClick={() => setExpanded(open ? "" : key)}
                >
                  <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span
                      className="pill"
                      data-tone={
                        alert.status === "ACTIVE"
                          ? "ok"
                          : alert.status === "WITHDRAWN_EARLY"
                            ? "bad"
                            : "muted"
                      }
                    >
                      {statusLabels[alert.status]}
                    </span>
                    <span className="text-sm font-medium text-ink-2">
                      {alert.mode === "RAIL" ? "Rail" : "Bus / NTA"} ·{" "}
                      {labelCategory(alert.category)}
                    </span>
                    <span className="ml-auto text-sm font-semibold text-brand">
                      {open ? "Hide details" : "View details"}
                    </span>
                  </span>
                  <span className="text-lg font-semibold [overflow-wrap:anywhere]">
                    {alert.title}
                  </span>
                  <span className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-ink-2 tabular-nums">
                    <span>
                      {alert.startsAt ? "Starts" : "First seen"}{" "}
                      {noticeTime.format(new Date(alert.startsAt ?? alert.firstSeen))}
                    </span>
                    <span>
                      {alert.endsAt
                        ? `Scheduled end ${noticeTime.format(new Date(alert.endsAt))}`
                        : "Open-ended"}
                    </span>
                    {alert.status === "WITHDRAWN_EARLY" ||
                    (alert.status === "ENDED" && !alert.endsAt) ? (
                      <span>Last seen {noticeTime.format(new Date(alert.lastSeen))}</span>
                    ) : null}
                    <span>
                      {alert.revisions} {alert.revisions === 1 ? "revision" : "revisions"}
                    </span>
                  </span>
                </button>
                {open ? <AlertDetails alert={alert} /> : null}
              </article>
            );
          })}
          {page > 1 || result.hasNextPage ? (
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                className="btn btn-quiet"
                disabled={page === 1}
                onClick={() => {
                  setExpanded("");
                  setPage(page - 1);
                }}
              >
                Previous
              </button>
              <span className="text-sm text-ink-2">Page {page}</span>
              <button
                type="button"
                className="btn btn-quiet"
                disabled={!result.hasNextPage}
                onClick={() => {
                  setExpanded("");
                  setPage(page + 1);
                }}
              >
                Next
              </button>
            </div>
          ) : null}
        </section>
      )}
      <p className="max-w-[72ch] text-sm text-ink-2">
        Early withdrawal is inferred when a notice stops appearing well before its scheduled end. A
        feed gap can look the same. NTA notices may cover Luas or rail services as well as buses.
      </p>
    </>
  );
}

function Stretches() {
  const [range, setRange] = useState(recentDates);
  const [mode, setMode] = useState<InsightsMode>("RAIL");
  const [band, setBand] = useState(0);
  const [minimum, setMinimum] = useState(10);
  const maxDays = mode === "BUS" ? 7 : 31;
  const valid = validRange(range, maxDays);
  const settled = useSettledFilters(JSON.stringify([range, mode, band, minimum]));
  const { start, end } = bands[band] ?? bands[0];
  const variables = { range, hourBand: { start, end }, minTrips: minimum };
  const [{ data, fetching, error }, reload] = useQuery<unknown>({
    query: DELAY_STRETCHES,
    variables: { ...variables, mode },
    pause: !valid || !settled,
    requestPolicy: "network-only",
  });
  const [{ data: dwellData, fetching: dwellFetching, error: dwellError }, reloadDwell] =
    useQuery<unknown>({
      query: RAIL_DWELL_HOTSPOTS,
      variables,
      pause: !valid || !settled || mode !== "RAIL",
      requestPolicy: "network-only",
    });
  const stretches = useMemo(() => readStretches(data), [data]);
  const dwell = readDwell(dwellData);

  return (
    <>
      <div className="card grid min-w-0 gap-3 p-4 text-sm">
        <div className="sm:justify-self-start [&>.seg]:w-full">
          <Segmented label="Stretch mode" options={modes} value={mode} onChange={setMode} />
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <DateControls
            range={range}
            onChange={setRange}
            descriptionId={mode === "BUS" ? "bus-stretch-range-help" : undefined}
          />
          <label className="grid min-w-0 gap-1">
            Irish time
            <select
              className="control"
              value={band}
              onChange={(event) => setBand(Number(event.target.value))}
            >
              {bands.map(({ label }, index) => (
                <option key={label} value={index}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="grid min-w-0 gap-1">
            Minimum trips
            <select
              className="control"
              value={minimum}
              onChange={(event) => setMinimum(Number(event.target.value))}
            >
              {[1, 5, 10, 25, 50, 100].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
        </div>
        {mode === "BUS" ? (
          <p id="bus-stretch-range-help" className="text-sm text-ink-2" role="status">
            Choose 1 to {maxDays} days for buses. Each day has about 250,000 hourly records and the
            query has a five-second time limit.
          </p>
        ) : null}
      </div>
      {!valid ? (
        mode === "RAIL" ? (
          <RangeMessage maxDays={maxDays} />
        ) : null
      ) : (
        <>
          {!settled || fetching ? (
            <Empty>Loading stretches…</Empty>
          ) : error || !stretches ? (
            <InsightsError onRetry={() => reload()} />
          ) : stretches.length === 0 ? (
            <Empty>No stretches match these filters.</Empty>
          ) : (
            <>
              <DelayStretchMap stretches={stretches} />
              <section
                className="card min-w-0 overflow-hidden"
                aria-labelledby="insights-stretch-heading"
              >
                <div className="card-head">
                  <h2 className="card-title" id="insights-stretch-heading">
                    Ranked stretches
                  </h2>
                </div>
                <div
                  className="overflow-x-auto"
                  tabIndex={0}
                  role="region"
                  aria-label="Stretch rankings"
                >
                  <table className="data-table min-w-[690px] tabular-nums">
                    <thead>
                      <tr>
                        <th scope="col">Stretch</th>
                        <th scope="col" className="num">
                          Trips
                        </th>
                        <th scope="col" className="num">
                          Net delay
                        </th>
                        <th scope="col" className="num">
                          Delay added
                        </th>
                        <th scope="col" className="num">
                          Avg gain
                        </th>
                        <th scope="col" className="num">
                          {mode === "BUS" ? "Median gain bucket" : "Std dev"}
                        </th>
                        <th scope="col" className="num">
                          Overrun
                        </th>
                        {mode === "BUS" ? (
                          <>
                            <th scope="col" className="num">
                              Trips gaining ≥2 min
                            </th>
                            <th scope="col">Routes</th>
                          </>
                        ) : null}
                      </tr>
                    </thead>
                    <tbody>
                      {stretches.map((stretch) => (
                        <tr key={JSON.stringify([stretch.fromId, stretch.toId])}>
                          <td className="min-w-48 font-medium [overflow-wrap:anywhere]">
                            {stretch.fromName} → {stretch.toName}
                          </td>
                          <td className="num">{numberFormat.format(stretch.trips)}</td>
                          <td className="num font-semibold">
                            {valueWithUnit(stretch.netDelayMinutes, " min")}
                          </td>
                          <td className="num">{valueWithUnit(stretch.addedMinutes, " min")}</td>
                          <td className="num">{valueWithUnit(stretch.avgGainMinutes, " min")}</td>
                          <td className="num">
                            {mode === "BUS"
                              ? medianBucket(stretch.medianGainLowerS, stretch.medianGainUpperS)
                              : valueWithUnit(stretch.stddevMinutes, " min")}
                          </td>
                          <td className="num">{valueWithUnit(stretch.overrunPct, "%")}</td>
                          {mode === "BUS" ? (
                            <>
                              <td className="num">
                                {valueWithUnit(stretch.gainAtLeastTwoMinutesPct, "%")}
                              </td>
                              <td>{stretch.routes.join(", ") || "—"}</td>
                            </>
                          ) : null}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          )}
          {mode === "RAIL" ? (
            <section
              className="card min-w-0 overflow-hidden"
              aria-labelledby="insights-dwell-heading"
            >
              <div className="card-head">
                <div>
                  <h2 className="card-title" id="insights-dwell-heading">
                    Delay at stations
                  </h2>
                  <p className="card-desc">Net delay between arriving at and leaving a station.</p>
                </div>
              </div>
              {!settled || dwellFetching ? (
                <Empty>Loading station delays…</Empty>
              ) : dwellError || !dwell ? (
                <InsightsError onRetry={() => reloadDwell()} />
              ) : dwell.length === 0 ? (
                <Empty>No stations match these filters.</Empty>
              ) : (
                <div
                  className="overflow-x-auto"
                  tabIndex={0}
                  role="region"
                  aria-label="Station delay rankings"
                >
                  <table className="data-table min-w-[510px] tabular-nums">
                    <thead>
                      <tr>
                        <th scope="col">Station</th>
                        <th scope="col" className="num">
                          Trips
                        </th>
                        <th scope="col" className="num">
                          Net delay
                        </th>
                        <th scope="col" className="num">
                          Delay added
                        </th>
                        <th scope="col" className="num">
                          Avg gain
                        </th>
                        <th scope="col" className="num">
                          Overrun
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {dwell.map((station) => (
                        <tr key={station.stationCode}>
                          <td className="min-w-32 font-medium [overflow-wrap:anywhere]">
                            {station.stationName}
                          </td>
                          <td className="num">{numberFormat.format(station.trips)}</td>
                          <td className="num font-semibold">
                            {valueWithUnit(station.netDelayMinutes, " min")}
                          </td>
                          <td className="num">{valueWithUnit(station.addedMinutes, " min")}</td>
                          <td className="num">{valueWithUnit(station.avgGainMinutes, " min")}</td>
                          <td className="num">{valueWithUnit(station.overrunPct, "%")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          ) : null}
        </>
      )}
      <div className="max-w-[72ch] space-y-2 text-sm text-ink-2">
        <p>
          Rankings show positive net delay after time recovered offsets increases in delay. Delay
          added sums just the increases. Overrun compares total running time with total timetabled
          time.
        </p>
        <p>
          {mode === "BUS"
            ? "Bus figures combine NTA predictions across timetable versions. The median gain is shown as a range."
            : "Rail figures use recorded times at station calls. Standard deviation shows how much gain varies across trains. Express services can span several stops, and today’s totals arrive after the service day."}
        </p>
        {mode === "BUS" ? <BusAttribution /> : null}
      </div>
    </>
  );
}

export default function Insights() {
  const [view, setView] = useState<"alerts" | "stretches">("alerts");
  return (
    <div className="page">
      <div className="page-inner min-w-0 gap-4 sm:gap-6">
        <header>
          <h1 className="page-title">Insights</h1>
          <p className="page-desc">Service notices and where delays build up across the network.</p>
        </header>
        <div className="sm:self-start [&>.seg]:w-full">
          <Segmented
            label="Insights view"
            value={view}
            onChange={setView}
            options={[
              { value: "alerts", label: "Service alerts" },
              { value: "stretches", label: "Delay stretches" },
            ]}
          />
        </div>
        {view === "alerts" ? <Alerts /> : <Stretches />}
      </div>
    </div>
  );
}
