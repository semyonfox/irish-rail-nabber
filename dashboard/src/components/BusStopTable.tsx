import { Link } from "react-router-dom";
import { DelayPill } from "./ui";
import { busJourneyPath, busStopPath, type BusStopDelay } from "../utils/busHistory";

const time = new Intl.DateTimeFormat("en-IE", {
  timeZone: "Europe/Dublin",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
export default function BusStopTable({
  stops,
  feedVersionId,
}: {
  stops: BusStopDelay[];
  feedVersionId: number;
}) {
  return (
    <div className="overflow-auto max-h-[36rem]">
      <table className="data-table min-w-[760px]">
        <thead>
          <tr>
            <th>Expected</th>
            <th>Destination / journey</th>
            <th>Stop</th>
            <th>Status</th>
            <th className="num">Delay</th>
            <th>Observed</th>
          </tr>
        </thead>
        <tbody>
          {stops.map((stop) => (
            <tr key={`${stop.tripInstanceKey}:${stop.stopSequence ?? stop.stopId}`}>
              <td>{stop.expectedTime ? time.format(Date.parse(stop.expectedTime)) : "—"}</td>
              <td>
                <Link
                  className="cell-main block underline"
                  to={busJourneyPath(feedVersionId, stop.tripInstanceKey)}
                >
                  {stop.headsign || stop.tripId || "Journey"}
                </Link>
                <small className="block text-muted">{stop.tripId}</small>
              </td>
              <td>
                {stop.stopId ? (
                  <Link className="underline" to={busStopPath(feedVersionId, stop.stopId)}>
                    {stop.stopName || stop.stopId}
                  </Link>
                ) : (
                  "Unknown stop"
                )}
              </td>
              <td>{stop.scheduleRelationship || "SCHEDULED"}</td>
              <td className="num">
                <DelayPill
                  minutes={stop.delaySeconds === null ? null : stop.delaySeconds / 60}
                  precise
                />
              </td>
              <td>
                <time dateTime={stop.lastUpdated}>{time.format(Date.parse(stop.lastUpdated))}</time>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
