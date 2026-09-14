export interface BusRealtimeStatus {
  lastSuccessAt: string | null;
  vehiclesLastSuccessAt?: string | null;
  tripUpdatesLastSuccessAt?: string | null;
  isLive: boolean;
}

export interface BusFeedState {
  badge: string;
  emptyTitle: string;
  emptyDescription: string;
  isLive: boolean;
  isLoading: boolean;
}

export function busFeedState(status: BusRealtimeStatus | null, fetching: boolean): BusFeedState {
  if (status == null && fetching) {
    return {
      badge: "Checking realtime",
      emptyTitle: "Checking live vehicle positions",
      emptyDescription: "Stop search remains available while the realtime feed is checked.",
      isLive: false,
      isLoading: true,
    };
  }

  if (status?.isLive) {
    return {
      badge: "Live NTA feed",
      emptyTitle: "No live positions yet",
      emptyDescription:
        "Stop search remains available. Tracking appears when NTA reports vehicle positions.",
      isLive: true,
      isLoading: false,
    };
  }

  if (status == null) {
    return {
      badge: "Status unavailable",
      emptyTitle: "Live status unavailable",
      emptyDescription:
        "The realtime feed could not be checked. Stop search will return when the API reconnects.",
      isLive: false,
      isLoading: false,
    };
  }

  return {
    badge: status?.lastSuccessAt ? "Realtime offline" : "Static feed only",
    emptyTitle: "Realtime positions unavailable",
    emptyDescription:
      "Stop search remains available from the static feed. Departures and vehicle tracking need a successful NTA realtime poll.",
    isLive: false,
    isLoading: false,
  };
}

// A healthy TripUpdates feed must not make stale vehicle positions look live.
export function busSourceStatus(
  status: BusRealtimeStatus | null,
  source: "vehicles" | "tripUpdates",
  now = Date.now(),
): BusRealtimeStatus | null {
  if (!status) return null;
  const lastSuccessAt =
    (source === "vehicles" ? status.vehiclesLastSuccessAt : status.tripUpdatesLastSuccessAt) ??
    null;
  const age = lastSuccessAt == null ? NaN : now - Date.parse(lastSuccessAt);
  return { ...status, lastSuccessAt, isLive: Number.isFinite(age) && age >= 0 && age < 180_000 };
}

export function busUpdateAge(value: string | null | undefined, now = Date.now()) {
  if (!value) return "No successful update";
  const age = now - Date.parse(value);
  if (!Number.isFinite(age) || age < 0) return "Time unavailable";
  const seconds = Math.floor(age / 1_000);
  if (seconds >= 86_400)
    return `${Math.floor(seconds / 86_400)}d ${Math.floor((seconds % 86_400) / 3_600)}h ago`;
  if (seconds >= 3_600)
    return `${Math.floor(seconds / 3_600)}h ${Math.floor((seconds % 3_600) / 60)}m ago`;
  return seconds < 60 ? `${seconds}s ago` : `${Math.floor(seconds / 60)}m ${seconds % 60}s ago`;
}
