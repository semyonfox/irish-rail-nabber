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

export default function TrainDetail({ trainCode, onClose }: Props) {
  const [{ data, fetching }] = usePollingQuery<TrainJourneyData>({
    query: TRAIN_JOURNEY,
    variables: { trainCode },
    pollInterval: 15000,
  });

  const stops = data?.trainJourney ?? [];
  const origin = stops[0]?.trainOrigin ?? "";
  const destination = stops[0]?.trainDestination ?? "";

  return (
    <div className="fixed inset-y-0 right-0 z-50 w-96 overflow-auto border-l border-[var(--rail-border)] bg-[var(--rail-surface)] p-4 shadow-xl">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-white">{trainCode}</h2>
          <p className="text-sm text-[var(--rail-muted)]">
            {origin} → {destination}
          </p>
        </div>
        <button
          onClick={onClose}
          className="rounded-lg p-2 text-[var(--rail-muted)] hover:bg-[var(--rail-bg)] hover:text-white"
        >
          ✕
        </button>
      </div>

      {fetching && !data && <p className="text-[var(--rail-muted)]">Loading journey...</p>}

      <div className="space-y-1">
        {stops.map((stop) => {
          const scheduled = stop.scheduledArrival || stop.scheduledDeparture;
          const actual = stop.actualArrival || stop.actualDeparture;
          const expected = stop.expectedArrival || stop.expectedDeparture;

          // calc delay in minutes if we have both
          let delayMin: number | null = null;
          if (scheduled && (actual || expected)) {
            const sTime = scheduled;
            const aTime = actual || expected || "";
            const [sh, sm] = sTime.split(":").map(Number);
            const [ah, am] = aTime.split(":").map(Number);
            delayMin = (ah - sh) * 60 + (am - sm);
          }

          return (
            <div
              key={stop.locationOrder}
              className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-[var(--rail-bg)]"
            >
              <div
                className="h-3 w-3 shrink-0 rounded-full"
                style={{ backgroundColor: delayColor(delayMin) }}
              />
              <div className="flex-1 min-w-0">
                <div className="truncate text-sm font-medium text-white">
                  {stop.locationFullName || stop.locationCode}
                </div>
                <div className="text-xs text-[var(--rail-muted)]">
                  Sched: {formatTime(scheduled)} {actual && `| Actual: ${formatTime(actual)}`}
                  {!actual && expected && `| Exp: ${formatTime(expected)}`}
                </div>
              </div>
              {delayMin != null && (
                <span className="text-xs font-medium" style={{ color: delayColor(delayMin) }}>
                  {delayMin <= 0 ? "On time" : `+${delayMin}m`}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
