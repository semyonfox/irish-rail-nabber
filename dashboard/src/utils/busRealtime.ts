export interface BusRealtimeStatus {
  lastSuccessAt: string | null;
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
      badge: "60 second live feed",
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
