import StationTable from "../components/StationTable";

export default function Stations() {
  return (
    <div className="p-6">
      <h2 className="mb-4 text-xl font-bold text-white">Station Performance</h2>
      <p className="mb-6 text-sm text-[var(--rail-muted)]">
        Delay statistics per station over the last 24 hours. Click column headers to sort.
      </p>
      <div className="rounded-xl border border-[var(--rail-border)] bg-[var(--rail-surface)]">
        <StationTable />
      </div>
    </div>
  );
}
