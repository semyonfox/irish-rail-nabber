import { useCallback, useState } from "react";
import StationDetail from "../components/StationDetail";
import type { RailStation } from "../components/TrainMap";
import StationTable from "../components/StationTable";
import { Card, PageHeader } from "../components/ui";

export default function Stations() {
  const [selectedStation, setSelectedStation] = useState<RailStation | null>(null);
  const selectStation = useCallback((station: Pick<RailStation, "stationCode" | "stationDesc">) => {
    setSelectedStation({
      ...station,
      stationType: null,
      isDart: null,
      latitude: null,
      longitude: null,
    });
  }, []);
  return (
    <div className="relative h-full">
      <div className="page">
        <div className="page-inner">
          <PageHeader
            eyebrow="Stops"
            title={
              <>
                Station <em>departures</em>
              </>
            }
            description="Search by station name or code, then choose a station for live departures. Compare delay statistics below."
          />
          <Card index={1}>
            <StationTable onStationSelect={selectStation} />
          </Card>
        </div>
      </div>
      {selectedStation && (
        <StationDetail station={selectedStation} onClose={() => setSelectedStation(null)} />
      )}
    </div>
  );
}
