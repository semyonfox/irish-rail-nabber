import StationTable from "../components/StationTable";

export default function Stations() {
  return (
    <div className="h-full overflow-auto p-4 md:p-6">
      <div className="mx-auto max-w-7xl">
        <div className="term-panel overflow-hidden">
          <div className="term-panel-head">
            Station performance
            <small>Delay statistics per station · click column headers to sort</small>
          </div>
          <StationTable />
        </div>
      </div>
    </div>
  );
}
