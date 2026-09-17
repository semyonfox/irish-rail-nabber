import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { STATION_DELAY_STATS } from "../graphql/queries";
import { usePollingQuery } from "../utils/usePollingQuery";
import { CHART, formatPct } from "../utils/format";
import { DelayPill, Empty } from "./ui";

interface StationStats {
  stationCode: string;
  stationDesc: string;
  avgLateMinutes: number;
  maxLateMinutes: number;
  onTimePct: number;
  totalEvents: number;
}

interface StationDelayStatsData {
  stationDelayStats: StationStats[];
}

export default function StationRiskChart() {
  const [{ data, fetching }] = usePollingQuery<StationDelayStatsData>({
    query: STATION_DELAY_STATS,
    variables: { hours: 24, limit: 15 },
    pollInterval: 60000,
  });

  if (fetching && !data) {
    return <Empty className="!min-h-80">Loading station delays…</Empty>;
  }

  const chartData = (data?.stationDelayStats ?? [])
    .filter((s) => s.totalEvents >= 3)
    .slice(0, 10)
    .map((s) => ({
      ...s,
      stationLabel: s.stationDesc.length > 22 ? `${s.stationDesc.slice(0, 20)}…` : s.stationDesc,
    }));

  if (chartData.length === 0) {
    return <Empty className="!min-h-80">No station delay data available</Empty>;
  }

  return (
    <>
      <ol className="space-y-4 sm:hidden" aria-label="Stations ranked by average delay">
        {chartData.map((station) => (
          <li key={station.stationCode} className="border-b border-line pb-3">
            <div className="flex items-start justify-between gap-3">
              <span className="min-w-0 font-semibold">{station.stationDesc}</span>
              <DelayPill minutes={station.avgLateMinutes} precise />
            </div>
            <p className="mt-2 text-[13px] text-muted">
              {formatPct(station.onTimePct)} within 5 min · worst +{station.maxLateMinutes}m
              <br />
              {station.totalEvents.toLocaleString()} stops observed
            </p>
          </li>
        ))}
      </ol>
      <div className="hidden sm:block">
        <ResponsiveContainer width="100%" height={360}>
          <BarChart
            data={chartData}
            layout="vertical"
            margin={{ top: 0, right: 44, left: 0, bottom: 0 }}
            barCategoryGap={8}
          >
            <CartesianGrid stroke={CHART.grid} horizontal={false} />
            <XAxis
              type="number"
              stroke={CHART.axis}
              fontSize={12}
              tickLine={false}
              axisLine={false}
              unit="m"
            />
            <YAxis
              type="category"
              dataKey="stationLabel"
              width={150}
              tick={{ fill: CHART.ink2, fontSize: 12.5 }}
              tickLine={false}
              axisLine={false}
            />
            <Tooltip
              cursor={{ fill: "var(--chart-cursor)" }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const row = payload[0].payload as StationStats;
                return (
                  <div className="rounded-xl border border-line bg-card px-3 py-2 text-[12.5px] shadow-lg">
                    <div className="font-semibold">{row.stationDesc}</div>
                    <div className="mt-1 text-muted">
                      Average {row.avgLateMinutes.toFixed(1)} min · worst {row.maxLateMinutes} min
                    </div>
                    <div className="text-muted">
                      {formatPct(row.onTimePct)} within 5 min · {row.totalEvents.toLocaleString()}{" "}
                      stops
                    </div>
                  </div>
                );
              }}
            />
            <Bar
              dataKey="avgLateMinutes"
              name="Average delay"
              fill={CHART.series1}
              radius={[0, 4, 4, 0]}
              maxBarSize={18}
            >
              <LabelList
                dataKey="avgLateMinutes"
                position="right"
                formatter={(value: unknown) => `${Number(value).toFixed(1)}m`}
                style={{ fill: CHART.ink2, fontSize: 11.5, fontWeight: 600 }}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </>
  );
}
