import { STATION_BOARD } from "../graphql/queries";
import { usePollingQuery } from "../utils/usePollingQuery";
import { formatTime, shortDelay } from "../utils/format";
import type { MapStationSelection } from "./TrainMap";
import { DelayPill, Empty, MiniStat, Sheet } from "./ui";

interface StationEvent {
  trainCode: string;
  origin: string | null;
  destination: string | null;
  trainType: string | null;
  direction: string | null;
  status: string | null;
  scheduledArrival: string | null;
  scheduledDeparture: string | null;
  expectedArrival: string | null;
  expectedDeparture: string | null;
  lateMinutes: number | null;
  dueIn: number | null;
  lastLocation: string | null;
}

interface StationBoardData {
  stationBoard: StationEvent[];
}

interface Props {
  station: MapStationSelection;
  onClose: () => void;
}

function stationTypeLabel(station: MapStationSelection) {
  if (station.isDart) return "DART";
  if (station.stationType === "M") return "Mainline";
  if (station.stationType === "S") return "Suburban";
  if (station.stationType === "A") return "Airport";
  return "Rail station";
}

function isRealTime(time: string | null | undefined) {
  return Boolean(time && time !== "00:00:00");
}

function pickTime(...times: (string | null | undefined)[]) {
  return times.find(isRealTime) ?? null;
}

function eventKind(event: StationEvent) {
  if (pickTime(event.expectedDeparture, event.scheduledDeparture)) return "Dep";
  if (pickTime(event.expectedArrival, event.scheduledArrival)) return "Arr";
  return "-";
}

function eventTime(event: StationEvent) {
  const time =
    eventKind(event) === "Dep"
      ? pickTime(event.expectedDeparture, event.scheduledDeparture)
      : pickTime(event.expectedArrival, event.scheduledArrival);
  return formatTime(time);
}

function dueLabel(dueIn: number | null) {
  if (dueIn == null) return "-";
  if (dueIn < 0) return "Left";
  if (dueIn === 0) return "Due";
  return `${dueIn} min`;
}

function routeText(event: StationEvent) {
  return `${event.origin || "—"} → ${event.destination || "—"}`;
}

export default function StationDetail({ station, onClose }: Props) {
  const [{ data, fetching }] = usePollingQuery<StationBoardData>({
    query: STATION_BOARD,
    variables: { stationCode: station.stationCode, limit: 18 },
    pollInterval: 10000,
  });

  const board = data?.stationBoard ?? [];
  const sortedBoard = [...board].sort((a, b) => {
    const pressure = (b.lateMinutes ?? 0) - (a.lateMinutes ?? 0);
    if (pressure !== 0) return pressure;
    return (a.dueIn ?? 9999) - (b.dueIn ?? 9999);
  });
  const delayed = board.filter((event) => (event.lateMinutes ?? 0) >= 5);
  const severe = board.filter((event) => (event.lateMinutes ?? 0) >= 15);
  const dueSoon = board.filter(
    (event) => event.dueIn != null && event.dueIn >= 0 && event.dueIn <= 10,
  );
  const nextEvent = [...board]
    .filter((event) => event.dueIn != null && event.dueIn >= -1)
    .sort((a, b) => (a.dueIn ?? 9999) - (b.dueIn ?? 9999))[0];
  const worstDelay = board.reduce((max, event) => Math.max(max, event.lateMinutes ?? 0), 0);

  return (
    <Sheet
      label="station details"
      onClose={onClose}
      eyebrow={
        <>
          <span className="chip">{station.stationCode}</span>
          {stationTypeLabel(station)}
        </>
      }
      title={station.stationDesc}
      subtitle={`${board.length} services on the live board`}
    >
      <div className="grid grid-cols-2 gap-2">
        <MiniStat label="Due in 10 min" value={dueSoon.length} />
        <MiniStat label="Worst delay" value={shortDelay(worstDelay)} />
        <MiniStat
          label="Delayed"
          value={delayed.length}
          tone={delayed.length > 0 ? "warn" : undefined}
        />
        <MiniStat
          label="Severe"
          value={severe.length}
          tone={severe.length > 0 ? "bad" : undefined}
        />
      </div>

      {nextEvent ? (
        <div className="rounded-2xl bg-brand-soft p-4">
          <div className="section-label !text-brand">
            <span>Next movement</span>
            <span className="font-semibold">{dueLabel(nextEvent.dueIn)}</span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-baseline gap-3">
              <span className="font-mono text-[26px] font-semibold tracking-[-0.03em]">
                {eventTime(nextEvent)}
              </span>
              <div className="min-w-0">
                <div className="truncate font-semibold">{routeText(nextEvent)}</div>
                <div className="code">
                  {nextEvent.trainCode} · {eventKind(nextEvent) === "Dep" ? "departs" : "arrives"}
                </div>
              </div>
            </div>
            <DelayPill minutes={nextEvent.lateMinutes} />
          </div>
          {nextEvent.lastLocation ? (
            <div className="mt-2 truncate text-[12.5px] text-ink-2">{nextEvent.lastLocation}</div>
          ) : null}
        </div>
      ) : null}

      <div>
        <div className="section-label">
          <span>Live board · most delayed first</span>
          {fetching ? <span className="code">Updating…</span> : null}
        </div>
        {board.length === 0 && !fetching ? (
          <Empty className="!min-h-24">No live board rows in the latest poll window.</Empty>
        ) : null}
        {sortedBoard.map((event) => {
          const scheduled = event.scheduledArrival || event.scheduledDeparture;
          const expected = event.expectedArrival || event.expectedDeparture;
          return (
            <div key={`${event.trainCode}-${scheduled}-${expected}`} className="board-row">
              <span className="board-time">{eventTime(event)}</span>
              <div className="min-w-0">
                <div className="truncate text-[14.5px] font-semibold">{routeText(event)}</div>
                <div className="truncate text-[12.5px] text-muted">
                  <span className="code">{event.trainCode}</span> · Due {dueLabel(event.dueIn)}
                  {event.lastLocation ? ` · ${event.lastLocation}` : ""}
                </div>
              </div>
              <DelayPill minutes={event.lateMinutes} />
            </div>
          );
        })}
      </div>

      <div className="code">
        {station.latitude.toFixed(4)}, {station.longitude.toFixed(4)}
      </div>
    </Sheet>
  );
}
