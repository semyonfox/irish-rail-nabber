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
import RequestError from "./RequestError";

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

const hoursOptions = [6, 24, 72, 168];

export default function StationTable() {
  const [sorting, setSorting] = useState<SortingState>([{ id: "avgLateMinutes", desc: true }]);
  const [search, setSearch] = useState("");
  const [hours, setHours] = useState(24);

  const [{ data, fetching, error }, retry] = usePollingQuery<StationDelayStatsData>({
    query: STATION_DELAY_STATS,
    variables: { hours, limit: 171 },
    pollInterval: 30000,
  });

  const columns = useMemo(
    () => [
      col.accessor("stationDesc", {
        header: "Station",
        cell: (info) => (
          <span>
            <span className="font-medium text-[var(--rail-text)]">{info.getValue()}</span>{" "}
            <span className="text-xs text-[var(--rail-muted)]">
              {info.row.original.stationCode}
            </span>
          </span>
        ),
      }),
      col.accessor("avgLateMinutes", {
        header: "Avg delay",
        cell: (info) => {
          const v = info.getValue();
          return (
            <span className="tabular-nums" style={{ color: delayColor(v) }}>
              {v.toFixed(1)} min
            </span>
          );
        },
      }),
      col.accessor("maxLateMinutes", {
        header: "Max delay",
        cell: (info) => <span className="tabular-nums">{info.getValue()} min</span>,
      }),
      col.accessor("onTimePct", {
        header: "On time %",
        cell: (info) => <span className="tabular-nums">{formatPct(info.getValue())}</span>,
      }),
      col.accessor("totalEvents", {
        header: "Events",
        cell: (info) => <span className="tabular-nums">{info.getValue()}</span>,
      }),
    ],
    [],
  );

  const needle = search.trim().toLowerCase();
  const rows = useMemo(() => {
    const all = data?.stationDelayStats ?? [];
    if (!needle) return all;
    return all.filter(
      (station) =>
        station.stationDesc.toLowerCase().includes(needle) ||
        station.stationCode.toLowerCase().includes(needle),
    );
  }, [data?.stationDelayStats, needle]);

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  if (fetching && !data) {
    return <div className="p-8 text-center text-[var(--rail-muted)]">Loading station data...</div>;
  }

  if (error && !data) {
    return (
      <RequestError
        error={error}
        onRetry={() => retry({ requestPolicy: "network-only" })}
        title="Station data unavailable"
      />
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--rail-border)] px-3 py-2">
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Filter by station name or code"
          className="term-control w-64 max-w-full"
          aria-label="Filter stations"
        />
        <select
          value={hours}
          onChange={(event) => setHours(Number(event.target.value))}
          className="term-control"
          aria-label="Statistics window"
        >
          {hoursOptions.map((option) => (
            <option key={option} value={option}>
              Last {option >= 24 ? `${option / 24}d` : `${option}h`}
            </option>
          ))}
        </select>
        <span className="ml-auto text-xs text-[var(--rail-muted)]">
          {rows.length} stations · sort by clicking headers
        </span>
      </div>
      <div className="overflow-auto">
        <table className="term-table">
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h) => (
                  <th
                    key={h.id}
                    onClick={h.column.getToggleSortingHandler()}
                    className="cursor-pointer hover:text-[var(--rail-text)]"
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
              <tr key={row.id}>
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
                ))}
              </tr>
            ))}
            {!fetching && table.getRowModel().rows.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length}
                  className="px-4 py-10 text-center text-[var(--rail-muted)]"
                >
                  {needle
                    ? `No stations match "${search.trim()}"`
                    : `No station performance records were returned for the selected window.`}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
