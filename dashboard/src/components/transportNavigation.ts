import type { IconName } from "./ui";

export type TransportMode = "rail" | "bus";

export interface TransportLink {
  to: string;
  label: string;
  icon: IconName;
}

const railPaths = ["/stations", "/analytics", "/history", "/chat"];

export const transportLinks: Record<TransportMode, TransportLink[]> = {
  rail: [
    { to: "/", label: "Live", icon: "map" },
    { to: "/stations", label: "Stations", icon: "pin" },
    { to: "/analytics", label: "Network", icon: "activity" },
    { to: "/history", label: "History", icon: "clock" },
    { to: "/chat", label: "Assistant", icon: "chat" },
  ],
  bus: [{ to: "/buses", label: "Departures", icon: "bus" }],
};

export function transportModeForPath(pathname: string): TransportMode | null {
  if (pathname === "/buses" || pathname.startsWith("/buses/")) return "bus";
  if (
    pathname === "/" ||
    railPaths.some((path) => pathname === path || pathname.startsWith(`${path}/`))
  ) {
    return "rail";
  }
  return null;
}
