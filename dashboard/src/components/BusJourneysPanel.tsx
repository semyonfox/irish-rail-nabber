import { useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { BUS_JOURNEYS } from "../graphql/queries";
import { busJourneyPath, isBusJourneysData } from "../utils/busHistory";
import { useCachedBusQuery } from "../utils/useCachedBusQuery";
import RequestError from "./RequestError";
import { Card, Empty, Segmented } from "./ui";

const time = new Intl.DateTimeFormat("en-IE", {
  timeZone: "Europe/Dublin",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
export default function BusJourneysPanel({
  routeId,
  feedVersionId,
}: {
  routeId: string;
  feedVersionId: number;
}) {
  const { user } = useAuth();
  const paid = !!user && ["coffee", "pro", "admin"].includes(user.role);
  const [selection, setSelection] = useState(24);
  const [search, setSearch] = useState("");
  const hours = paid ? selection : Math.min(selection || 72, 72);
  const result = useCachedBusQuery({
    query: BUS_JOURNEYS,
    variables: { routeId, feedVersionId, hours },
    validate: isBusJourneysData,
    cacheScope: `${user?.id ?? "anonymous"}:${user?.role ?? "free"}`,
  });
  const journeys = (result.data?.busJourneys ?? []).filter((j) =>
    `${j.tripId} ${j.headsign}`.toLowerCase().includes(search.toLowerCase()),
  );
  const ranges = [
    { value: 24, label: "24 hours" },
    { value: 72, label: "3 days" },
    ...(paid
      ? [
          { value: 168, label: "7 days" },
          { value: 720, label: "30 days" },
          { value: 0, label: "All time" },
        ]
      : []),
  ];
  return (
    <Card
      title="Recorded journeys"
      description="Latest 200 journeys in the selected window. Open a journey to see its last reported prediction at each stop."
    >
      <div className="card-body flex flex-wrap gap-3">
        <Segmented
          label="Journey history window"
          options={ranges}
          value={hours}
          onChange={setSelection}
        />
        <input
          className="input"
          aria-label="Search recorded journeys"
          placeholder="Search destination or trip…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <span className="text-xs text-muted" role="status">
          {result.cached
            ? "Saved on this device"
            : result.fetching
              ? "Updating journeys…"
              : `${journeys.length} journeys shown`}
        </span>
      </div>
      {result.error && (
        <RequestError
          error={result.error}
          onRetry={result.retry}
          title="Journeys could not refresh"
        />
      )}
      <div className="overflow-auto max-h-96">
        <table className="data-table min-w-[580px]">
          <thead>
            <tr>
              <th>Journey</th>
              <th>First observed</th>
              <th>Last observed</th>
              <th className="num">Stops</th>
            </tr>
          </thead>
          <tbody>
            {journeys.map((j) => (
              <tr key={j.tripInstanceKey}>
                <td>
                  <Link
                    className="cell-main block underline"
                    to={busJourneyPath(feedVersionId, j.tripInstanceKey)}
                  >
                    {j.headsign || j.tripId || "Journey"}
                  </Link>
                  <small className="block text-muted">{j.tripId}</small>
                </td>
                <td>{time.format(Date.parse(j.firstObserved))}</td>
                <td>{time.format(Date.parse(j.lastObserved))}</td>
                <td className="num">{j.stopCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!result.fetching && !journeys.length && (
        <Empty>No recorded journeys match this selection.</Empty>
      )}
    </Card>
  );
}
