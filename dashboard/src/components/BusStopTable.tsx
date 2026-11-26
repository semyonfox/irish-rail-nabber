import { Link } from "react-router-dom";
import { busJourneyPath, busStopPath, type BusStopDelay } from "../utils/busHistory";
import { DelayPill } from "./ui";

const time = new Intl.DateTimeFormat("en-IE", {
  timeZone: "Europe/Dublin",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export default function BusStopTable({
  stops,
  feedVersionId,
  routeId,
  showJourney = true,
}: {
  stops: BusStopDelay[];
  feedVersionId: number;
  routeId: string;
  showJourney?: boolean;
}) {
  return (
    <div className="responsive-table-frame max-h-[36rem] overflow-auto">
      <table role="table" className="data-table responsive-table min-w-[760px]">
        <thead role="rowgroup">
          <tr role="row">
            <th role="columnheader" scope="col">
              Expected
            </th>
            {showJourney && (
              <th role="columnheader" scope="col">
                Destination / journey
              </th>
            )}
            <th role="columnheader" scope="col">
              Stop
            </th>
            <th role="columnheader" scope="col">
              Status
            </th>
            <th role="columnheader" scope="col" className="num">
              Delay
            </th>
            <th role="columnheader" scope="col">
              Observed
            </th>
          </tr>
        </thead>
        <tbody role="rowgroup">
          {stops.map((stop) => (
            <tr role="row" key={`${stop.tripInstanceKey}:${stop.stopSequence ?? stop.stopId}`}>
              <td role="cell" data-label="Expected" className="whitespace-nowrap">
                {stop.expectedTime ? time.format(Date.parse(stop.expectedTime)) : "—"}
              </td>
              {showJourney && (
                <td role="cell" data-label="Destination / journey">
                  <Link
                    className="cell-main block underline"
                    to={busJourneyPath(feedVersionId, routeId, stop.tripInstanceKey)}
                  >
                    {stop.headsign || stop.tripId || "Journey"}
                  </Link>
                  <small className="block text-muted">{stop.tripId}</small>
                </td>
              )}
              <td role="cell" data-label="Stop">
                {stop.stopId ? (
                  <Link className="underline" to={busStopPath(feedVersionId, stop.stopId)}>
                    {stop.stopName || stop.stopId}
                  </Link>
                ) : (
                  "Unknown stop"
                )}
              </td>
              <td role="cell" data-label="Status">
                {stop.scheduleRelationship || "SCHEDULED"}
              </td>
              <td role="cell" data-label="Delay" className="num">
                <DelayPill
                  minutes={stop.delaySeconds === null ? null : stop.delaySeconds / 60}
                  precise
                />
              </td>
              <td role="cell" data-label="Observed" className="whitespace-nowrap">
                <time dateTime={stop.lastUpdated}>{time.format(Date.parse(stop.lastUpdated))}</time>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
