import type { MapRouteSelection } from "./TrainMap";

interface Props {
  route: MapRouteSelection;
  onClose: () => void;
}

function formatLastSeen(value: string | null) {
  if (!value) return "Unknown";
  return value.replace("T", " ").slice(0, 16);
}

export default function RouteDetail({ route, onClose }: Props) {
  return (
    <div className="fixed inset-y-0 right-0 z-50 w-full overflow-auto border-l border-[var(--rail-border)] bg-[var(--rail-surface)] p-4 shadow-xl sm:w-96">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--rail-green)]">
            Route link
          </p>
          <h2 className="text-lg font-bold text-white">
            {route.fromStationName} to {route.toStationName}
          </h2>
          <p className="text-sm text-[var(--rail-muted)]">
            {route.fromStationCode} {"->"} {route.toStationCode}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg px-2 py-1.5 text-sm text-[var(--rail-muted)] hover:bg-[var(--rail-bg)] hover:text-white"
          aria-label="Close route panel"
        >
          X
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2 text-sm">
        <div className="rounded-lg border border-[var(--rail-border)] bg-[var(--rail-bg)]/70 p-3">
          <div className="text-xs text-[var(--rail-muted)]">Recent trains</div>
          <div className="text-xl font-semibold text-white">{route.trainCount}</div>
        </div>
        <div className="rounded-lg border border-[var(--rail-border)] bg-[var(--rail-bg)]/70 p-3">
          <div className="text-xs text-[var(--rail-muted)]">Last seen</div>
          <div className="text-sm font-medium text-white">{formatLastSeen(route.lastSeen)}</div>
        </div>
      </div>
    </div>
  );
}
