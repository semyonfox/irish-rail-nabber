import { useCallback, useEffect, useMemo, useState } from "react";
import { Linking, View } from "react-native";

import { clock, type BusStop } from "../src/api";
import type { MapPoint } from "../src/map-data";
import { MapPanel } from "../src/map-panel";
import { useApi } from "../src/session";
import { usePalette } from "../src/theme";
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

const stopName = (stop: BusStop) =>
  stop.stopName || stop.stopCode || stop.stopId;
// gtfs can send a realtime time without a delay, so derive it when it's missing
function busDelay(bus: {
  delaySeconds: number | null;
  expectedTime: string | null;
  scheduledTime: string | null;
}) {
  if (bus.delaySeconds != null) return Math.round(bus.delaySeconds / 60);
  if (!bus.expectedTime || !bus.scheduledTime) return null;
  if (bus.expectedTime === bus.scheduledTime) return null;
  const minutes = Math.round(
    (Date.parse(bus.expectedTime) - Date.parse(bus.scheduledTime)) / 60_000,
  );
  return Number.isFinite(minutes) ? minutes : null;
}

const routeName = (shortName: string | null, routeId: string | null) =>
  shortName || routeId || "Bus";

function Attribution() {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 8 }}>
      <Button
        label="NTA bus data"
        onPress={() =>
          void Linking.openURL("https://data.gov.ie/dataset/nta-gtfs")
        }
      />
      <Button
        label="CC BY 4.0"
        onPress={() =>
          void Linking.openURL("https://creativecommons.org/licenses/by/4.0/")
        }
      />
    </View>
  );
}

function LiveBuses({ onStops }: { onStops: () => void }) {
  const { busPositions } = useApi();
  const live = useResource(busPositions, { interval: 60_000 });
  const lastSuccess = live.data?.lastSuccess;
  // vehicle age, not the server's isLive, which also counts trip updates that
  // can stay healthy while positions stall. the daemon alternates feeds so
  // vehicles land about every 135 to 200 s, and a minute of slack covers a phone
  // clock running slightly behind
  const age =
    lastSuccess && live.data
      ? live.data.receivedAt - Date.parse(lastSuccess)
      : NaN;
  const current = Number.isFinite(age) && age > -60_000 && age < 240_000;
  const points = useMemo(
    () =>
      (live.data?.vehicles ?? []).flatMap<MapPoint>((vehicle, index) => {
        if (vehicle.latitude === 0 && vehicle.longitude === 0) return [];
        return [
          {
            id:
              vehicle.entityId ||
              [vehicle.vehicleId, vehicle.routeId, index].join(":"),
            latitude: vehicle.latitude,
            longitude: vehicle.longitude,
            label: routeName(vehicle.routeShortName, vehicle.routeId),
            detail: [vehicle.headsign, vehicle.operatorName]
              .filter(Boolean)
              .join(" · "),
          },
        ];
      }),
    [live.data?.vehicles],
  );

  return (
    <Screen title="Buses" refresh={live.refresh} refreshing={live.refreshing}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <Copy variant="section" accessibilityRole="header" style={{ flex: 1 }}>
          Vehicle positions
        </Copy>
        <Button label="Find a stop" onPress={onStops} />
      </View>
      <MapPanel
        points={points}
        mode="bus"
        caption={
          lastSuccess
            ? `${current ? "Updated" : "Last update"} ${clock(lastSuccess) ?? "unknown"}`
            : null
        }
        loading={live.kind === "loading"}
        error={live.error}
        empty={
          current
            ? "No bus positions reported."
            : "Realtime bus positions unavailable."
        }
        retry={live.refresh}
      />
      {live.data && !live.error && !current ? (
        <Notice title="Waiting for the NTA feed" retry={live.refresh}>
          {points.length > 0
            ? "These positions may be out of date. You can still look up a stop."
            : "You can still look up a stop."}
        </Notice>
      ) : null}
      <Attribution />
    </Screen>
  );
}

function StopResults({
  search,
  onSelect,
}: {
  search: string;
  onSelect: (stop: BusStop) => void;
}) {
  const api = useApi();
  const load = useCallback(
    (signal: AbortSignal) => api.busStops(search, signal),
    [api, search],
  );
  const stops = useResource(load, { maxAge: 300_000 });
  return (
    <>
      {stops.error ? (
        <Notice title="Stop search unavailable" darken retry={stops.refresh}>
          {stops.error}
        </Notice>
      ) : null}
      {stops.kind === "loading" ? <Skeleton label="Finding stops" /> : null}
      {stops.data?.length === 0 ? (
        <Notice title="No matching stops">
          Try a different stop name or number.
        </Notice>
      ) : null}
      {stops.data?.length ? (
        <Card>
          {stops.data.map((stop, index) => (
            <Row
              key={stop.stopId}
              first={index === 0}
              onPress={() => onSelect(stop)}
            >
              <Copy variant="label" style={{ flex: 1 }}>
                {stopName(stop)}
              </Copy>
              {stop.stopCode ? (
                <Figures variant="small" tone="secondary">
                  {stop.stopCode}
                </Figures>
              ) : null}
            </Row>
          ))}
        </Card>
      ) : null}
    </>
  );
}

function StopSearch({
  search,
  setSearch,
  onMap,
  onSelect,
}: {
  search: string;
  setSearch: (search: string) => void;
  onMap: () => void;
  onSelect: (stop: BusStop) => void;
}) {
  useBack(onMap);
  const needle = search.trim();
  const [settled, setSettled] = useState(needle);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(needle), 450);
    return () => clearTimeout(timer);
  }, [needle]);

  return (
    <Screen title="Buses">
      <View style={{ alignItems: "flex-start" }}>
        <Button label="Back to map" onPress={onMap} />
      </View>
      <Field
        label="Find a stop"
        placeholder="Stop name or number"
        value={search}
        onChangeText={setSearch}
        // the api rejects searches over 100 characters
        maxLength={100}
        returnKeyType="search"
      />
      {needle.length < 2 ? (
        <Copy variant="small" tone="secondary">
          Enter at least two characters.
        </Copy>
      ) : settled !== needle ? (
        <Skeleton label="Finding stops" />
      ) : (
        <StopResults search={settled} onSelect={onSelect} />
      )}
      <Attribution />
    </Screen>
  );
}

function BusBoard({ stop, onBack }: { stop: BusStop; onBack: () => void }) {
  useBack(onBack);
  const colours = usePalette();
  const api = useApi();
  const load = useCallback(
    (signal: AbortSignal) => api.busBoard(stop.stopId, signal),
    [api, stop.stopId],
  );
  const board = useResource(load, { interval: 60_000 });
  const now = useNow();

  return (
    <Screen title="Buses" refresh={board.refresh} refreshing={board.refreshing}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <View style={{ flex: 1 }}>
          <Copy variant="section" accessibilityRole="header">
            {stopName(stop)}
          </Copy>
          {stop.stopCode ? (
            <Figures variant="small" tone="secondary">
              Stop {stop.stopCode}
            </Figures>
          ) : null}
        </View>
        <Button label="Change stop" onPress={onBack} />
      </View>
      <Copy variant="label">Departures</Copy>
      {board.error ? (
        <Notice
          title={
            board.data ? "Showing the last board" : "Departures unavailable"
          }
          darken
          retry={board.refresh}
        >
          {board.error}
        </Notice>
      ) : null}
      {board.kind === "loading" ? (
        <Skeleton label="Loading departures" />
      ) : null}
      {board.data?.length === 0 ? (
        <Notice title="No departures reported" retry={board.refresh}>
          Nothing due here soon, or live departures are briefly unavailable. Try
          again in a moment.
        </Notice>
      ) : null}
      {board.data?.length ? (
        <Card>
          {board.data.map((bus, index) => {
            const time = clock(bus.expectedTime) ?? clock(bus.scheduledTime);
            const at = Date.parse(bus.expectedTime ?? bus.scheduledTime ?? "");
            const due = Number.isFinite(at)
              ? dueText(Math.round((at - now) / 60_000))
              : null;
            const route = routeName(bus.routeShortName, bus.routeId);
            const cancelled = /cancel|skip|delet/i.test(
              bus.scheduleRelationship ?? "",
            );
            return (
              <Row
                key={`${bus.entityId ?? bus.tripId}:${bus.serviceDate}:${bus.scheduledTime ?? bus.expectedTime}:${index}`}
                first={index === 0}
              >
                <View
                  style={{ width: 80, alignItems: "flex-end" }}
                  accessible
                  accessibilityLabel={[time, due].filter(Boolean).join(", ")}
                >
                  <Figures>{time ?? "–"}</Figures>
                  {due ? (
                    <Figures variant="small" tone="secondary">
                      {due}
                    </Figures>
                  ) : null}
                </View>
                <View style={{ flex: 1, gap: 3 }}>
                  <View
                    style={{
                      alignSelf: "flex-start",
                      backgroundColor: colours.busSoft,
                      borderRadius: 4,
                      paddingHorizontal: 6,
                    }}
                  >
                    <Figures variant="small" tone="busDeep">
                      {route}
                    </Figures>
                  </View>
                  <Copy variant="label">
                    {bus.headsign ||
                      bus.routeLongName ||
                      "Destination unavailable"}
                  </Copy>
                  {bus.operatorName ? (
                    <Copy variant="small" tone="secondary">
                      {bus.operatorName}
                    </Copy>
                  ) : null}
                </View>
                <Delay
                  minutes={busDelay(bus)}
                  cancelled={cancelled}
                  // the api falls back to the scheduled time when there is no
                  // realtime data, and gtfs can also send an on-time absolute
                  // time with no delay. the fields can't tell those apart
                  scheduled={
                    busDelay(bus) == null &&
                    bus.scheduledTime != null &&
                    (bus.expectedTime == null ||
                      bus.expectedTime === bus.scheduledTime)
                  }
                />
              </Row>
            );
          })}
        </Card>
      ) : null}
      <Attribution />
    </Screen>
  );
}

export default function Buses() {
  const [finding, setFinding] = useState(false);
  const [stop, setStop] = useState<BusStop | null>(null);
  const [search, setSearch] = useState("");

  if (stop) return <BusBoard stop={stop} onBack={() => setStop(null)} />;
  if (finding)
    return (
      <StopSearch
        search={search}
        setSearch={setSearch}
        onSelect={setStop}
        onMap={() => setFinding(false)}
      />
    );
  return <LiveBuses onStops={() => setFinding(true)} />;
}
