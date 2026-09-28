import { useMemo, useState } from "react";
import { flexRender, type SortingState } from "@tanstack/react-table";
import {
  getCoreRowModel,
  getSortedRowModel,
  legacyCreateColumnHelper,
  useLegacyTable,
} from "@tanstack/react-table/legacy";
import { STATION_DELAY_STATS } from "../graphql/queries";
import { usePollingQuery } from "../utils/usePollingQuery";
import { formatPct } from "../utils/format";
import RequestError from "./RequestError";
import { DelayPill, Empty, Icon, SearchInput, Segmented } from "./ui";

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

const col = legacyCreateColumnHelper<StationStats>();

const hoursOptions = [
  { value: 6, label: "6 hours" },
  { value: 24, label: "24 hours" },
  { value: 72, label: "3 days" },
  { value: 168, label: "7 days" },
];

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
    () =>
      col.columns([
        col.accessor("stationDesc", {
          header: "Station",
          cell: (info) => (
            <span className="flex items-center gap-2">
              <span className="cell-main">{info.getValue()}</span>
              <span className="chip">{info.row.original.stationCode}</span>
            </span>
          ),
        }),
        col.accessor("avgLateMinutes", {
          header: "Average delay",
          cell: (info) => <DelayPill minutes={info.getValue()} precise />,
        }),
        col.accessor("maxLateMinutes", {
          header: "Worst delay",
          cell: (info) => `+${info.getValue()}m`,
        }),
        col.accessor("onTimePct", {
          header: "Within 5 min",
          cell: (info) => formatPct(info.getValue()),
        }),
        col.accessor("totalEvents", {
          header: "Stops observed",
          cell: (info) => <span className="text-muted">{info.getValue().toLocaleString()}</span>,
        }),
      ]),
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

  const table = useLegacyTable({
    data: rows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  if (fetching && !data) {
    return <Empty>Loading station data…</Empty>;
  }

  if (error && !data) {
    return (
      <RequestError
        bare
        error={error}
        onRetry={() => retry({ requestPolicy: "network-only" })}
        title="Station data unavailable"
      />
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 px-5 py-4">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search station name or code"
          label="Filter stations"
          className="w-full sm:w-72"
        />
        <Segmented
          label="Statistics window"
          options={hoursOptions}
          value={hours}
          onChange={setHours}
        />
        <span className="ml-auto text-[13px] text-muted">{rows.length} stations</span>
      </div>
      <div className="overflow-auto">
        <table className="data-table min-w-[720px]">
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h) => {
                  const sorted = h.column.getIsSorted();
                  return (
                    <th
                      key={h.id}
                      className={h.column.id === "stationDesc" ? "" : "num"}
                      aria-sort={
                        sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none"
                      }
                    >
                      <button
                        type="button"
                        className="sort-btn"
                        onClick={h.column.getToggleSortingHandler()}
                      >
                        {flexRender(h.column.columnDef.header, h.getContext())}
                        <Icon
                          name={
                            sorted === "asc" ? "sortUp" : sorted === "desc" ? "sortDown" : "sort"
                          }
                        />
                      </button>
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr key={row.id}>
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className={cell.column.id === "stationDesc" ? "" : "num"}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
            {!fetching && table.getRowModel().rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="py-12 text-center text-muted">
                  {needle
                    ? `No stations match “${search.trim()}”`
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
