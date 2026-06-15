import { TRAIN_JOURNEY } from "../graphql/queries";
import { usePollingQuery } from "../utils/usePollingQuery";
import { formatTime, delayColor } from "../utils/format";

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

function delayText(delayMin: number | null) {
  if (delayMin == null) return "N/A";
  if (delayMin <= 0) return "RT";
  return `+${delayMin}m`;
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
    <div className="fixed inset-y-0 right-0 z-50 w-full overflow-auto border-l border-[var(--rail-border)] bg-[var(--rail-surface)] p-4 shadow-xl sm:w-96">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-white">{trainCode}</h2>
          <p className="text-sm text-[var(--rail-muted)]">
            {origin} → {destination}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg p-2 text-[var(--rail-muted)] hover:bg-[var(--rail-bg)] hover:text-white"
          aria-label="Close train panel"
        >
          ✕
        </button>
      </div>

      {fetching && !data && <p className="text-[var(--rail-muted)]">Loading journey...</p>}
      {!fetching && stops.length === 0 && (
        <p className="rounded-lg border border-[var(--rail-border)] bg-[var(--rail-bg)]/70 p-3 text-sm text-[var(--rail-muted)]">
          No station-by-station journey has been captured for this train yet.
        </p>
      )}

      {stops.length > 0 && (
        <>
          <div className="mb-4 grid grid-cols-2 gap-2 text-sm">
            <div className="rounded-lg border border-[var(--rail-border)] bg-[var(--rail-bg)]/70 p-3">
              <div className="text-xs text-[var(--rail-muted)]">Stops</div>
              <div className="text-xl font-semibold text-white">{stops.length}</div>
            </div>
            <div className="rounded-lg border border-[var(--rail-border)] bg-[var(--rail-bg)]/70 p-3">
              <div className="text-xs text-[var(--rail-muted)]">Late stops</div>
              <div className="text-xl font-semibold text-[var(--rail-orange)]">
                {delayedStops.length}
              </div>
            </div>
            <div className="rounded-lg border border-[var(--rail-border)] bg-[var(--rail-bg)]/70 p-3">
              <div className="text-xs text-[var(--rail-muted)]">Severe stops</div>
              <div className="text-xl font-semibold text-[var(--rail-red)]">
                {severeStops.length}
              </div>
            </div>
            <div className="rounded-lg border border-[var(--rail-border)] bg-[var(--rail-bg)]/70 p-3">
              <div className="text-xs text-[var(--rail-muted)]">Worst</div>
              <div className="text-xl font-semibold text-white">
                {delayText(worstStop?.delayMin ?? null)}
              </div>
            </div>
          </div>

          <div className="mb-4 rounded-lg border border-[var(--rail-border)] bg-[var(--rail-bg)]/70 p-3">
            <div className="mb-2 flex items-center justify-between text-xs text-[var(--rail-muted)]">
              <span>Journey progress</span>
              <span>{progress}%</span>
            </div>
            <div className="h-2 rounded bg-[var(--rail-surface)]">
              <div
                className="h-2 rounded bg-[var(--rail-green)]"
                style={{ width: `${progress}%` }}
              />
            </div>
            {nextStop && (
              <div className="mt-3 flex items-start justify-between gap-3 text-sm">
                <div className="min-w-0">
                  <div className="truncate font-semibold text-white">
                    {stopKind(nextStop)} {formatTime(stopTime(nextStop))}
                  </div>
                  <div className="truncate text-xs text-[var(--rail-muted)]">
                    {nextStop.locationFullName || nextStop.locationCode}
                  </div>
                </div>
                <span
                  className="shrink-0 text-xs font-semibold"
                  style={{ color: delayColor(stopDelay(nextStop)) }}
                >
                  {delayText(stopDelay(nextStop))}
                </span>
              </div>
            )}
          </div>
        </>
      )}

      <div className="space-y-1">
        {stopRows.map(({ stop, delayMin }) => {
          const scheduled = scheduledTime(stop);
          const observed = stopTime(stop);
          const isComplete = Boolean(stop.actualArrival || stop.actualDeparture);
          return (
            <div
              key={stop.locationOrder}
              className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-[var(--rail-bg)]"
            >
              <div
                className={`h-3 w-3 shrink-0 rounded-full ${isComplete ? "" : "ring-2 ring-white/20"}`}
                style={{ backgroundColor: delayColor(delayMin) }}
              />
              <div className="flex-1 min-w-0">
                <div className="truncate text-sm font-medium text-white">
                  {stop.locationFullName || stop.locationCode}
                </div>
                <div className="text-xs text-[var(--rail-muted)]">
                  {stopKind(stop)} {formatTime(observed)} · sched {formatTime(scheduled)}
                  {stop.stopType && ` · ${stop.stopType}`}
                </div>
              </div>
              <span className="text-xs font-medium" style={{ color: delayColor(delayMin) }}>
                {delayText(delayMin)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
