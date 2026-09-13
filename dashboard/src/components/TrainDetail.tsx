import { TRAIN_JOURNEY } from "../graphql/queries";
import { usePollingQuery } from "../utils/usePollingQuery";
import { formatTime, shortDelay } from "../utils/format";
import { DelayPill, Empty, MiniStat, Sheet } from "./ui";

interface Movement {
  trainCode: string;
  trainDate: string;
  locationCode: string | null;
  locationFullName: string | null;
  locationOrder: number;
  trainOrigin: string | null;
  trainDestination: string | null;
  scheduledArrival: string | null;
  scheduledDeparture: string | null;
  expectedArrival: string | null;
  expectedDeparture: string | null;
  actualArrival: string | null;
  actualDeparture: string | null;
  stopType: string | null;
}

interface TrainJourneyData {
  trainJourney: Movement[];
}

interface Props {
  trainCode: string;
  onClose: () => void;
}

function timeToMinutes(time: string | null | undefined) {
  if (!time) return null;
  const [hours, minutes] = time.split(":").map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return hours * 60 + minutes;
}

function stopDelay(stop: Movement) {
  const scheduled = stop.scheduledArrival || stop.scheduledDeparture;
  const observed =
    stop.actualArrival || stop.actualDeparture || stop.expectedArrival || stop.expectedDeparture;
  const scheduledMinutes = timeToMinutes(scheduled);
  const observedMinutes = timeToMinutes(observed);
  if (scheduledMinutes == null || observedMinutes == null) return null;

  let diff = observedMinutes - scheduledMinutes;
  if (diff < -720) diff += 1440;
  if (diff > 720) diff -= 1440;
  return diff;
}

function stopTime(stop: Movement) {
  return (
    stop.actualArrival || stop.actualDeparture || stop.expectedArrival || stop.expectedDeparture
  );
}

function scheduledTime(stop: Movement) {
  return stop.scheduledArrival || stop.scheduledDeparture;
}

function stopKind(stop: Movement) {
  if (stop.scheduledDeparture || stop.expectedDeparture || stop.actualDeparture) return "Dep";
  if (stop.scheduledArrival || stop.expectedArrival || stop.actualArrival) return "Arr";
  return "Stop";
}

export default function TrainDetail({ trainCode, onClose }: Props) {
  const [{ data, fetching }] = usePollingQuery<TrainJourneyData>({
    query: TRAIN_JOURNEY,
    variables: { trainCode },
    pollInterval: 15000,
  });

  const stops = [...(data?.trainJourney ?? [])].sort((a, b) => a.locationOrder - b.locationOrder);
  const origin = stops[0]?.trainOrigin ?? "";
  const destination = stops[0]?.trainDestination ?? "";
  const stopRows = stops.map((stop) => ({ stop, delayMin: stopDelay(stop) }));
  const delayedStops = stopRows.filter(({ delayMin }) => (delayMin ?? 0) >= 5);
  const severeStops = stopRows.filter(({ delayMin }) => (delayMin ?? 0) >= 15);
  const completedStops = stops.filter((stop) => stop.actualArrival || stop.actualDeparture).length;
  const worstStop = stopRows.reduce<(typeof stopRows)[number] | null>((worst, row) => {
    if (!worst) return row;
    return (row.delayMin ?? -999) > (worst.delayMin ?? -999) ? row : worst;
  }, null);
  const nextStop =
    stops.find((stop) => !stop.actualArrival && !stop.actualDeparture && stopTime(stop)) ??
    stops[completedStops] ??
    null;
  const progress = stops.length > 0 ? Math.round((completedStops / stops.length) * 100) : 0;

  return (
    <Sheet
      label="train details"
      onClose={onClose}
      eyebrow={
        <>
          Train <span className="chip">{trainCode}</span>
        </>
      }
      title={origin && destination ? `${origin} to ${destination}` : `Train ${trainCode}`}
      subtitle={
        stops.length > 0 ? `${stops.length} calling points · ${progress}% complete` : undefined
      }
    >
      {fetching && !data ? <Empty>Loading journey…</Empty> : null}
      {!fetching && stops.length === 0 ? (
        <Empty>No station-by-station journey has been captured for this train yet.</Empty>
      ) : null}

      {stops.length > 0 ? (
        <>
          <div className="grid grid-cols-2 gap-2">
            <MiniStat label="Stops" value={stops.length} />
            <MiniStat label="Worst" value={shortDelay(worstStop?.delayMin ?? null)} />
            <MiniStat
              label="Late stops"
              value={delayedStops.length}
              tone={delayedStops.length > 0 ? "warn" : undefined}
            />
            <MiniStat
              label="Severe stops"
              value={severeStops.length}
              tone={severeStops.length > 0 ? "bad" : undefined}
            />
          </div>

          <div className="rounded-2xl border border-line p-4">
            <div className="section-label">
              <span>Journey progress</span>
              <span className="code">{progress}%</span>
            </div>
            <div className="meter">
              <span style={{ width: `${progress}%` }} />
            </div>
            {nextStop ? (
              <div className="mt-4 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[12.5px] text-muted">Next stop</div>
                  <div className="truncate font-semibold">
                    {nextStop.locationFullName || nextStop.locationCode}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <span className="board-time">{formatTime(stopTime(nextStop))}</span>
                  <DelayPill minutes={stopDelay(nextStop)} />
                </div>
              </div>
            ) : null}
          </div>

          <div>
            <div className="section-label">Calling points</div>
            <ol className="timeline">
              {stopRows.map(({ stop, delayMin }) => {
                const isComplete = Boolean(stop.actualArrival || stop.actualDeparture);
                const isNext = nextStop?.locationOrder === stop.locationOrder;
                return (
                  <li key={stop.locationOrder}>
                    <span className="tl-rail" data-done={isComplete} data-next={isNext}>
                      <span className="tl-dot" />
                    </span>
                    <div className="min-w-0">
                      <div
                        className={`truncate text-[14.5px] ${isNext ? "font-semibold" : "font-medium"} ${isComplete ? "text-ink-2" : "text-ink"}`}
                      >
                        {stop.locationFullName || stop.locationCode}
                      </div>
                      <div className="code mt-0.5">
                        {stopKind(stop)} {formatTime(stopTime(stop))} · sched{" "}
                        {formatTime(scheduledTime(stop))}
                        {stop.stopType ? ` · ${stop.stopType}` : ""}
                      </div>
                    </div>
                    <DelayPill minutes={delayMin} />
                  </li>
                );
              })}
            </ol>
          </div>
        </>
      ) : null}
    </Sheet>
  );
}
