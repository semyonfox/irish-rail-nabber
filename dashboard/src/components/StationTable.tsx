import { useMemo, useState } from "react";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type SortingState,
} from "@tanstack/react-table";
import { STATION_DELAY_STATS } from "../graphql/queries";
import { usePollingQuery } from "../utils/usePollingQuery";
import { formatPct, delayColor } from "../utils/format";

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

const col = createColumnHelper<StationStats>();

export default function StationTable() {
  const [sorting, setSorting] = useState<SortingState>([{ id: "avgLateMinutes", desc: true }]);

  const [{ data, fetching }] = usePollingQuery<StationDelayStatsData>({
    query: STATION_DELAY_STATS,
    variables: { hours: 24, limit: 171 },
    pollInterval: 30000,
  });

  const columns = useMemo(
    () => [
      col.accessor("stationDesc", {
        header: "Station",
        cell: (info) => <span className="font-medium text-white">{info.getValue()}</span>,
      }),
      col.accessor("avgLateMinutes", {
        header: "Avg Delay",
        cell: (info) => {
          const v = info.getValue();
          return <span style={{ color: delayColor(v) }}>{v.toFixed(1)} min</span>;
        },
      }),
      col.accessor("maxLateMinutes", {
        header: "Max Delay",
        cell: (info) => `${info.getValue()} min`,
      }),
      col.accessor("onTimePct", {
        header: "On Time %",
        cell: (info) => formatPct(info.getValue()),
      }),
      col.accessor("totalEvents", {
        header: "Events",
      }),
    ],
    [],
  );

  const table = useReactTable({
    data: data?.stationDelayStats ?? [],
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  if (fetching && !data) {
    return <div className="p-8 text-center text-[var(--rail-muted)]">Loading station data...</div>;
  }

  return (
    <div className="overflow-auto">
      <table className="w-full text-sm">
        <thead>
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id} className="border-b border-[var(--rail-border)]">
              {hg.headers.map((h) => (
                <th
                  key={h.id}
                  onClick={h.column.getToggleSortingHandler()}
                  className="cursor-pointer px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[var(--rail-muted)] hover:text-white"
                >
                  {flexRender(h.column.columnDef.header, h.getContext())}
                  {{ asc: " ↑", desc: " ↓" }[h.column.getIsSorted() as string] ?? ""}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr
              key={row.id}
              className="border-b border-[var(--rail-border)] hover:bg-[var(--rail-surface)]"
            >
              {row.getVisibleCells().map((cell) => (
                <td key={cell.id} className="px-4 py-3">
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
