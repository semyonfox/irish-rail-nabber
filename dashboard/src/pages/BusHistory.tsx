import { Link } from "react-router-dom";
import BusStopRankings from "../components/BusStopRankings";
import BusHistoryPanel from "../components/BusHistoryPanel";
import { PageHeader } from "../components/ui";

export default function BusHistory() {
  return (
    <div className="page">
      <div className="page-inner">
        <PageHeader
          eyebrow="Buses"
          title={
            <>
              Network <em>history</em>
            </>
          }
          description="Explore recorded bus predictions across the network."
          actions={
            <Link to="/buses/routes" className="text-sm underline">
              Find a route
            </Link>
          }
        />
        <p className="text-sm">
          Looking for earlier records?{" "}
          <Link to="/buses/published" className="underline">
            Explore imported NTA route performance
          </Link>
          .
        </p>
        <BusHistoryPanel />
        <BusStopRankings />
        <p className="bus-attribution">
          Data from <a href="https://www.nationaltransport.ie/">NTA</a>,{" "}
          <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>. Supplied as is.
        </p>
      </div>
    </div>
  );
}
