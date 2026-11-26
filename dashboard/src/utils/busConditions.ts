export interface BusServiceNotice {
  noticeId: string;
  header: string;
  description: string;
  url: string | null;
  category: string;
  startsAt: string | null;
  endsAt: string | null;
  routeIds: string[];
  routeShortNames: string[];
  stopCount: number;
}

export interface BusBunch {
  routeId: string;
  routeShortName: string | null;
  headsign: string | null;
  /** in order along the route, matching `BusVehicle.tripId` */
  tripIds: string[];
  spreadMetres: number;
  scheduledGapMinutes: number;
}

const categoryLabels: Record<string, string> = {
  disruption: "Disruption",
  diversion: "Diversion",
  delay: "Delays",
  stop_change: "Stop change",
  timetable: "Timetable",
  works: "Works",
};

export function noticeCategoryLabel(category: string) {
  return categoryLabels[category] ?? "Notice";
}

export function noticesForRoute(notices: BusServiceNotice[], routeId: string | null) {
  return routeId ? notices.filter((notice) => notice.routeIds.includes(routeId)) : [];
}
