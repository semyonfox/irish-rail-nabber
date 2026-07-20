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
    return (
      <div className="flex h-80 items-center justify-center text-[var(--rail-muted)]">
        Loading station risk...
      </div>
    );
  }

  const chartData = (data?.stationDelayStats ?? [])
    .filter((s) => s.totalEvents >= 3)
    .slice(0, 10)
    .reverse()
    .map((s) => ({
      ...s,
      stationLabel: s.stationDesc.length > 24 ? `${s.stationDesc.slice(0, 22)}...` : s.stationDesc,
    }));

  if (chartData.length === 0) {
    return (
      <div className="flex h-80 items-center justify-center text-[var(--rail-muted)]">
        No station delay data available
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={360}>
      <BarChart
        data={chartData}
        layout="vertical"
        margin={{ top: 8, right: 44, left: 24, bottom: 0 }}
        barCategoryGap={6}
      >
        <CartesianGrid stroke={CHART.grid} horizontal={false} />
        <XAxis type="number" stroke={CHART.axis} fontSize={11} tickLine={false} unit="m" />
        <YAxis
          type="category"
          dataKey="stationLabel"
          width={132}
          stroke={CHART.axis}
          fontSize={11}
          tickLine={false}
        />
        <Tooltip
          cursor={{ fill: "rgba(255,255,255,0.04)" }}
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const row = payload[0].payload as StationStats;
            return (
              <div className="border border-[var(--rail-border)] bg-[var(--rail-surface)] p-3 text-xs text-[var(--rail-text)]">
                <div className="font-semibold">{row.stationDesc}</div>
                <div className="mt-1 text-[var(--rail-muted)]">
                  Avg {row.avgLateMinutes.toFixed(1)} min · max {row.maxLateMinutes} min
                </div>
                <div className="text-[var(--rail-muted)]">
                  {formatPct(row.onTimePct)} within 5 min · {row.totalEvents.toLocaleString()} stops
                </div>
              </div>
            );
          }}
        />
        <Bar dataKey="avgLateMinutes" name="Avg delay" fill={CHART.series1} radius={[0, 4, 4, 0]}>
          <LabelList
            dataKey="avgLateMinutes"
            position="right"
            formatter={(value: unknown) => `${Number(value).toFixed(1)}m`}
            style={{ fill: CHART.ink, fontSize: 10 }}
          />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
