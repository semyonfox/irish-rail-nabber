import { Link } from "react-router-dom";
import BusAttribution from "../components/BusAttribution";
import BusHistoryPanel from "../components/BusHistoryPanel";
import BusStopRankings from "../components/BusStopRankings";
import { PageHeader } from "../components/ui";

export default function BusHistory() {
  return (
    <div className="page">
      <div className="page-inner">
        <PageHeader
          eyebrow="History"
          title={
            <>
              Network <em>history</em>
            </>
          }
          description="Reported bus predictions across the network, hour by hour, and the stops with the largest delays."
          actions={
            <Link to="/buses/routes" className="text-sm underline">
              Find a route
            </Link>
          }
        />
        <p className="text-sm text-muted">
          Looking further back?{" "}
          <Link to="/buses/published" className="underline">
            See the NTA's published route performance
          </Link>
          , reported by contract and four-week period.
        </p>
        <BusHistoryPanel />
        <BusStopRankings />
        <BusAttribution />
      </div>
    </div>
  );
}
