import { useCallback, useMemo, useState } from "react";
import { View } from "react-native";

import type { Station } from "../src/api";
import { useApi } from "../src/session";
import {
  Button,
  Card,
  Copy,
  Delay,
  Field,
  Figures,
  Notice,
  Row,
  Screen,
  Skeleton,
  useBack,
  dueText,
  useNow,
} from "../src/ui";
import { useResource } from "../src/use-resource";

const railTime = (value: string | null) =>
  value && value !== "00:00:00" ? value.slice(0, 5) : null;

const dublinClock = new Intl.DateTimeFormat("en-IE", {
  timeZone: "Europe/Dublin",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const minutesOf = (hhmm: string) =>
  Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

// minutes from now until hh:mm in Dublin, in [-60, 1380) so a board that
// crosses midnight still sorts. dueIn isn't used: the daemon only stores rows
// when something changes, so it can be minutes stale, and it counts to arrival
function minutesUntil(hhmm: string, at: number) {
  const now = minutesOf(dublinClock.format(at));
  return ((minutesOf(hhmm) - now + 1440 + 60) % 1440) - 60;
}

function RailBoard({
  station,
  onBack,
}: {
  station: Station;
  onBack: () => void;
}) {
  useBack(onBack);
  const api = useApi();
  const load = useCallback(
    (signal: AbortSignal) => api.stationBoard(station.stationCode, signal),
    [api, station.stationCode],
  );
  const board = useResource(load, { interval: 45_000 });
  const [mode, setMode] = useState<"departures" | "arrivals">("departures");

  const now = useNow();
  const rows = useMemo(
    () =>
      (board.data ?? [])
        .flatMap((event) => {
          const departure = mode === "departures";
          const expected = railTime(
            departure ? event.expectedDeparture : event.expectedArrival,
          );
          const scheduled = railTime(
            departure ? event.scheduledDeparture : event.scheduledArrival,
          );
          const time = expected ?? scheduled;
          if (!time) return [];
          const until = minutesUntil(time, now);
          // a minute of grace before calling it gone, on this board's own
          // time (departure or arrival)
          return [{ event, scheduled, time, until, gone: until < -1 }];
        })
        .sort((a, b) => Number(a.gone) - Number(b.gone) || a.until - b.until),
    [board.data, mode, now],
  );

  return (
    <Screen
      title="Stations"
      refresh={board.refresh}
      refreshing={board.refreshing}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <View style={{ flex: 1 }}>
          <Copy variant="section" accessibilityRole="header">
            {station.stationDesc}
          </Copy>
          <Figures variant="small" tone="secondary">
            {station.stationCode}
          </Figures>
        </View>
        <Button label="Change station" onPress={onBack} />
      </View>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Button
          label="Departures"
          selected={mode === "departures"}
          onPress={() => setMode("departures")}
        />
        <Button
          label="Arrivals"
          selected={mode === "arrivals"}
          onPress={() => setMode("arrivals")}
        />
      </View>
      {board.error ? (
        <Notice
          title={
            board.data ? "Showing the last board" : "Station board unavailable"
          }
          darken
          retry={board.refresh}
        >
          {board.error}
        </Notice>
      ) : null}
      {board.kind === "loading" ? (
        <Skeleton label="Loading station board" />
      ) : null}
      {board.data && rows.length === 0 ? (
        <Notice title={`No ${mode} reported`} retry={board.refresh}>
          Check the other board or try again in a moment.
        </Notice>
      ) : null}
      {rows.length ? (
        <Card>
          {rows.map(({ event, scheduled, time, until, gone }, index) => {
            const place =
              mode === "departures" ? event.destination : event.origin;
            const cancelled = /cancel/i.test(event.status ?? "");
            return (
              <Row key={event.trainCode} first={index === 0}>
                {/* the delay label already says how late, so the second line
                    is the countdown rather than the scheduled time */}
                <View
                  style={{ width: 80, alignItems: "flex-end" }}
                  accessible
                  accessibilityLabel={[
                    time,
                    scheduled && scheduled !== time
                      ? `scheduled ${scheduled}`
                      : null,
                    gone ? null : dueText(until),
                  ]
                    .filter(Boolean)
                    .join(", ")}
                >
                  <Figures>{time}</Figures>
                  {!gone && dueText(until) ? (
                    <Figures variant="small" tone="secondary">
                      {dueText(until)}
                    </Figures>
                  ) : null}
                </View>
                <View style={{ flex: 1 }}>
                  <Copy variant="label">
                    {place
                      ? mode === "departures"
                        ? place
                        : `From ${place}`
                      : mode === "departures"
                        ? "Destination unavailable"
                        : "Origin unavailable"}
                  </Copy>
                  <Copy variant="small" tone="secondary">
                    {[event.trainCode, event.trainType]
                      .filter(Boolean)
                      .join(" · ")}
                  </Copy>
                </View>
                <Delay
                  minutes={event.lateMinutes}
                  cancelled={cancelled}
                  gone={
                    gone
                      ? mode === "departures"
                        ? "Departed"
                        : "Arrived"
                      : undefined
                  }
                />
              </Row>
            );
          })}
        </Card>
      ) : null}
    </Screen>
  );
}

function useStations() {
  const { stations } = useApi();
  return useResource(stations, { maxAge: 1_800_000 });
}

function StationSearch({
  list,
  onSelect,
  search,
  setSearch,
}: {
  list: ReturnType<typeof useStations>;
  onSelect: (station: Station) => void;
  search: string;
  setSearch: (search: string) => void;
}) {
  const needle = search.trim().toLocaleLowerCase("en-IE");
  const matches = (list.data ?? [])
    .filter((station) =>
      `${station.stationDesc} ${station.stationCode}`
        .toLocaleLowerCase("en-IE")
        .includes(needle),
    )
    .sort((a, b) => a.stationDesc.localeCompare(b.stationDesc, "en-IE"));
  const limit = 32;

  return (
    <Screen
      title="Stations"
      refresh={list.refresh}
      refreshing={list.refreshing}
    >
      <Field
        label="Find a station"
        value={search}
        onChangeText={setSearch}
        placeholder="Station name or code"
        returnKeyType="search"
      />
      {list.error ? (
        <Notice
          title={
            list.data ? "Showing the last station list" : "Stations unavailable"
          }
          darken
          retry={list.refresh}
        >
          {list.error}
        </Notice>
      ) : null}
      {list.kind === "loading" ? <Skeleton label="Loading stations" /> : null}
      {list.data && matches.length === 0 ? (
        <Notice
          title={needle ? "No matching stations" : "No stations available"}
          retry={needle ? undefined : list.refresh}
        >
          {needle
            ? "Try another station name or code."
            : "Refresh to check for updates."}
        </Notice>
      ) : null}
      {matches.length > 0 ? (
        <View style={{ gap: 8 }}>
          <Figures
            variant="small"
            tone="secondary"
            accessibilityLiveRegion="polite"
          >
            {matches.length > limit
              ? `Showing ${limit} of ${matches.length} stations. Search to narrow the list.`
              : `${matches.length} ${matches.length === 1 ? "station" : "stations"}`}
          </Figures>
          <Card>
            {matches.slice(0, limit).map((station, index) => (
              <Row
                key={station.stationCode}
                first={index === 0}
                onPress={() => onSelect(station)}
              >
                <Copy variant="label" style={{ flex: 1 }}>
                  {station.stationDesc}
                </Copy>
                <Figures variant="small" tone="secondary">
                  {station.stationCode}
                </Figures>
              </Row>
            ))}
          </Card>
        </View>
      ) : null}
    </Screen>
  );
}

export default function Stations() {
  const [station, setStation] = useState<Station | null>(null);
  const [search, setSearch] = useState("");
  // held here so picking a station and coming back doesn't refetch the list
  const list = useStations();

  return station ? (
    <RailBoard station={station} onBack={() => setStation(null)} />
  ) : (
    <StationSearch
      list={list}
      search={search}
      setSearch={setSearch}
      onSelect={setStation}
    />
  );
}
