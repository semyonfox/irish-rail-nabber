import { useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { BUS_JOURNEYS } from "../graphql/queries";
import {
  busHistoryMaxHours,
  busHistoryRanges,
  busJourneyPath,
  type BusJourney,
} from "../utils/busHistory";
import { usePollingQuery } from "../utils/usePollingQuery";
import RequestError from "./RequestError";
import { Card, Empty, SearchInput, Segmented } from "./ui";

const time = new Intl.DateTimeFormat("en-IE", {
  timeZone: "Europe/Dublin",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export default function BusJourneysPanel({
  routeId,
  feedVersionId,
}: {
  routeId: string;
  feedVersionId: number;
}) {
  const { user } = useAuth();
  const maxHours = busHistoryMaxHours(user?.role);
  const [selection, setSelection] = useState(24);
  const [search, setSearch] = useState("");
  const hours = Math.min(selection, maxHours);
  const [{ data, fetching, error }, retry] = usePollingQuery<{ busJourneys: BusJourney[] }>({
    query: BUS_JOURNEYS,
    variables: { routeId, feedVersionId, hours },
    pollInterval: 120_000,
  });
  const needle = search.trim().toLowerCase();
  const journeys = (data?.busJourneys ?? []).filter((journey) =>
    `${journey.tripId ?? ""} ${journey.headsign ?? ""}`.toLowerCase().includes(needle),
  );

  return (
    <Card
      title="Recorded journeys"
      description="Latest 200 journeys in the selected window. Open one to see its last reported prediction at each stop."
    >
      <div className="card-body flex flex-wrap items-center gap-3">
        <Segmented
          label="Journey history window"
          options={busHistoryRanges(maxHours).filter((range) => range.value >= 24)}
          value={hours}
          onChange={setSelection}
        />
        <SearchInput
          value={search}
          onChange={setSearch}
          label="Search recorded journeys"
          placeholder="Destination or trip"
        />
        <span className="text-xs text-muted" role="status">
          {fetching ? "Updating journeys…" : `${journeys.length} journeys shown`}
        </span>
      </div>
      {error && (
        <RequestError
          error={error}
          onRetry={() => retry({ requestPolicy: "network-only" })}
          title="Journeys could not refresh"
        />
      )}
      {journeys.length > 0 ? (
        <div className="max-h-96 overflow-auto">
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
              {journeys.map((journey) => (
                <tr key={journey.tripInstanceKey}>
                  <td>
                    <Link
                      className="cell-main block underline"
                      to={busJourneyPath(feedVersionId, routeId, journey.tripInstanceKey)}
                    >
                      {journey.headsign || journey.tripId || "Journey"}
                    </Link>
                    <small className="block text-muted">{journey.tripId}</small>
                  </td>
                  <td className="whitespace-nowrap">
                    {time.format(Date.parse(journey.firstObserved))}
                  </td>
                  <td className="whitespace-nowrap">
                    {time.format(Date.parse(journey.lastObserved))}
                  </td>
                  <td className="num">{journey.stopCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : !fetching && !error ? (
        <Empty>No recorded journeys match this selection.</Empty>
      ) : null}
    </Card>
  );
}
