import StationTable from "../components/StationTable";
import { Card, PageHeader } from "../components/ui";
import { useState } from "react";
import StationDetail from "../components/StationDetail";

export default function Stations() {
  const [station, setStation] = useState<{ stationCode: string; stationDesc: string } | null>(null);
  return (
    <div className="page stations-page">
      <div className="page-inner">
        <PageHeader
          eyebrow="Stations"
          title={
            <>
              Station <em>performance</em>
            </>
          }
          description="Search by name or code, then select a station to open departures. The table shows delay statistics for the selected window."
        />
        <Card index={1}>
          <StationTable onStationSelect={setStation} />
        </Card>
        {station ? (
          <StationDetail
            key={station.stationCode}
            station={station}
            onClose={() => setStation(null)}
          />
        ) : null}
      </div>
    </div>
  );
}
