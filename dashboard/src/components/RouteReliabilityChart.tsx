import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ROUTE_RELIABILITY } from "../graphql/queries";
import { usePollingQuery } from "../utils/usePollingQuery";

interface Route {
  origin: string;
  destination: string;
  avgLateMinutes: number;
  onTimePct: number;
  trainCount: number;
}

interface RouteReliabilityData {
  routeReliability: Route[];
}

export default function RouteReliabilityChart() {
  const [{ data, fetching }] = usePollingQuery<RouteReliabilityData>({
    query: ROUTE_RELIABILITY,
    variables: { hours: 24, minTrains: 3 },
    pollInterval: 60000,
  });

  if (fetching && !data) {
    return (
      <div className="flex h-80 items-center justify-center text-[var(--rail-muted)]">
        Loading route reliability...
      </div>
    );
  }

  const chartData = (data?.routeReliability ?? []).slice(0, 10).map((route) => {
    const label = `${route.origin} to ${route.destination}`;
    return {
      ...route,
      routeLabel: label.length > 24 ? `${label.slice(0, 22)}...` : label,
    };
  });

  if (chartData.length === 0) {
    return (
      <div className="flex h-80 items-center justify-center text-[var(--rail-muted)]">
        No route reliability data available
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={360}>
      <ComposedChart data={chartData} margin={{ top: 8, right: 0, left: 0, bottom: 56 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
        <XAxis
          dataKey="routeLabel"
          stroke="#94a3b8"
          fontSize={12}
          interval={0}
          tickLine={false}
          angle={-35}
          textAnchor="end"
        />
        <YAxis
          yAxisId="delay"
          stroke="#94a3b8"
          fontSize={12}
          tickLine={false}
          label={{
            value: "Delay (min)",
            angle: -90,
            position: "insideLeft",
            style: { fill: "#94a3b8", fontSize: 12 },
          }}
        />
        <YAxis
          yAxisId="reliability"
          orientation="right"
          domain={[0, 100]}
          stroke="#22c55e"
          fontSize={12}
          tickFormatter={(v) => `${v}%`}
          tickLine={false}
          axisLine={false}
        />
        <Tooltip
          labelFormatter={(_, payload) => {
            const route = payload?.[0]?.payload as Route | undefined;
            return route ? `${route.origin} to ${route.destination}` : "";
          }}
          formatter={(value, name) => {
            if (name === "Within 5 min") return [`${Number(value).toFixed(1)}%`, name];
            return [`${Number(value).toFixed(1)} min`, name];
          }}
          contentStyle={{
            backgroundColor: "#1e293b",
            border: "1px solid #334155",
            borderRadius: "8px",
            color: "#f1f5f9",
          }}
        />
        <Legend wrapperStyle={{ color: "#cbd5e1", fontSize: 12 }} />
        <Bar
          yAxisId="delay"
          dataKey="avgLateMinutes"
          name="Avg delay"
          fill="#f97316"
          radius={[4, 4, 0, 0]}
        />
        <Line
          yAxisId="reliability"
          type="monotone"
          dataKey="onTimePct"
          name="Within 5 min"
          stroke="#22c55e"
          strokeWidth={2}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
