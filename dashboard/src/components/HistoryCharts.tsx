import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { CHART, CHART_TOOLTIP_STYLE } from "../utils/format";
import { Card, ChartLegend } from "./ui";

export interface HistoryChartPoint {
  label: string;
  avgLateMinutes: number;
  p95LateMinutes: number;
  onTimePct: number;
  eventCount: number;
}

const AXIS_WIDTH = 48;
const axisProps = {
  stroke: CHART.axis,
  fontSize: 12,
  tickLine: false,
  axisLine: false,
} as const;
const activeDot = { r: 4, strokeWidth: 2, stroke: CHART.surface };

// lower bound for the reliability axis so a 90-99% band doesn't flatten out
function reliabilityFloor(min: number) {
  return Math.max(0, Math.floor((min - 5) / 10) * 10);
}

export default function HistoryCharts({ data }: { data: HistoryChartPoint[] }) {
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card
        index={5}
        title="Delay trend"
        description="Average and 95th-percentile delay, with board observations below"
      >
        <div className="card-body">
          <ChartLegend
            items={[
              { label: "Average delay", color: CHART.series1 },
              { label: "95th percentile", color: CHART.series2 },
            ]}
          />
          <ResponsiveContainer width="100%" height={260}>
            <LineChart
              data={data}
              syncId="history"
              margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
            >
              <CartesianGrid stroke={CHART.grid} vertical={false} />
              <XAxis dataKey="label" hide />
              <YAxis {...axisProps} unit="m" width={AXIS_WIDTH} />
              <Tooltip
                contentStyle={CHART_TOOLTIP_STYLE}
                formatter={(value, name) => [`${Number(value).toFixed(1)} min`, name]}
                cursor={{ stroke: CHART.axis, strokeWidth: 1 }}
              />
              <Line
                type="monotone"
                dataKey="avgLateMinutes"
                name="Average delay"
                stroke={CHART.series1}
                strokeWidth={2}
                dot={false}
                activeDot={activeDot}
              />
              <Line
                type="monotone"
                dataKey="p95LateMinutes"
                name="95th percentile"
                stroke={CHART.series2}
                strokeWidth={2}
                dot={false}
                activeDot={activeDot}
              />
            </LineChart>
          </ResponsiveContainer>
          <div className="mt-3 text-[12px] font-medium text-muted">Board observations</div>
          <ResponsiveContainer width="100%" height={76}>
            <BarChart
              data={data}
              syncId="history"
              margin={{ top: 4, right: 8, left: AXIS_WIDTH, bottom: 0 }}
            >
              <XAxis dataKey="label" {...axisProps} fontSize={11} minTickGap={32} />
              <YAxis hide />
              <Tooltip
                contentStyle={CHART_TOOLTIP_STYLE}
                formatter={(value) => [Number(value).toLocaleString(), "Observations"]}
                cursor={{ fill: "rgb(18 24 20 / 0.04)" }}
              />
              <Bar
                dataKey="eventCount"
                name="Observations"
                fill={CHART.volume}
                radius={[3, 3, 0, 0]}
                maxBarSize={24}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <Card
        index={6}
        title="Reliability"
        description="Share of stops within five minutes of schedule"
      >
        <div className="card-body">
          <ResponsiveContainer width="100%" height={372}>
            <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid stroke={CHART.grid} vertical={false} />
              <XAxis dataKey="label" {...axisProps} fontSize={11} minTickGap={32} />
              <YAxis
                {...axisProps}
                domain={[(min: number) => reliabilityFloor(min), 100]}
                unit="%"
                width={AXIS_WIDTH}
              />
              <Tooltip
                contentStyle={CHART_TOOLTIP_STYLE}
                formatter={(value) => [`${Number(value).toFixed(1)}%`, "Within 5 minutes"]}
                cursor={{ stroke: CHART.axis, strokeWidth: 1 }}
              />
              <Line
                type="monotone"
                dataKey="onTimePct"
                name="Within 5 minutes"
                stroke={CHART.series1}
                strokeWidth={2}
                dot={false}
                activeDot={activeDot}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Card>
    </div>
  );
}
