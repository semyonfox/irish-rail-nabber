import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export interface HistoryChartPoint {
  label: string;
  avgLateMinutes: number;
  p95LateMinutes: number;
  onTimePct: number;
  eventCount: number;
}

function ChartFrame({
  title,
  detail,
  children,
}: {
  title: string;
  detail: string;
  children: React.ReactNode;
}) {
  return (
    <section className="term-panel overflow-hidden">
      <div className="term-panel-head">
        {title}
        <small>{detail}</small>
      </div>
      <div className="px-2 py-4">{children}</div>
    </section>
  );
}

export default function HistoryCharts({ data }: { data: HistoryChartPoint[] }) {
  return (
    <div className="grid gap-5 xl:grid-cols-2">
      <ChartFrame title="Delay trend" detail="Average delay and disruption spikes">
        <ResponsiveContainer width="100%" height={340}>
          <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
            <XAxis
              dataKey="label"
              stroke="#94a3b8"
              fontSize={11}
              tickLine={false}
              minTickGap={32}
            />
            <YAxis yAxisId="delay" stroke="#94a3b8" fontSize={12} tickLine={false} unit="m" />
            <YAxis
              yAxisId="events"
              orientation="right"
              stroke="#64748b"
              fontSize={12}
              tickLine={false}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "#1e293b",
                border: "1px solid #334155",
                borderRadius: "8px",
              }}
            />
            <Legend wrapperStyle={{ color: "#cbd5e1", fontSize: 12 }} />
            <Bar
              yAxisId="events"
              dataKey="eventCount"
              name="Board observations"
              fill="#334155"
              radius={[3, 3, 0, 0]}
            />
            <Line
              yAxisId="delay"
              type="monotone"
              dataKey="avgLateMinutes"
              name="Average delay"
              stroke="#22c55e"
              strokeWidth={2}
              dot={false}
            />
            <Line
              yAxisId="delay"
              type="monotone"
              dataKey="p95LateMinutes"
              name="p95 delay"
              stroke="#f97316"
              strokeWidth={2}
              dot={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </ChartFrame>

      <ChartFrame title="Reliability" detail="Share of stops within 5 minutes">
        <ResponsiveContainer width="100%" height={340}>
          <LineChart data={data} margin={{ top: 8, right: 20, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
            <XAxis
              dataKey="label"
              stroke="#94a3b8"
              fontSize={11}
              tickLine={false}
              minTickGap={32}
            />
            <YAxis domain={[0, 100]} stroke="#94a3b8" fontSize={12} tickLine={false} unit="%" />
            <Tooltip
              contentStyle={{
                backgroundColor: "#1e293b",
                border: "1px solid #334155",
                borderRadius: "8px",
              }}
            />
            <Line
              type="monotone"
              dataKey="onTimePct"
              name="Within 5 minutes"
              stroke="#22c55e"
              strokeWidth={2.5}
              dot={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </ChartFrame>
    </div>
  );
}
