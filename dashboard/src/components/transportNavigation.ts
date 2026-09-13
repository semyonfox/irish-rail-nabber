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
    { to: "/stations", label: "Stops", icon: "pin" },
    { to: "/analytics", label: "Network", icon: "activity" },
    { to: "/history", label: "History", icon: "clock" },
    { to: "/chat", label: "Assistant", icon: "chat" },
  ],
  bus: [
    { to: "/buses", label: "Live", icon: "map" },
    { to: "/buses/stops", label: "Stops", icon: "pin" },
    { to: "/buses/network", label: "Network", icon: "activity" },
  ],
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

export function transportModePath(pathname: string, mode: TransportMode): string {
  if (pathname === "/stations" || pathname === "/buses/stops") {
    return mode === "bus" ? "/buses/stops" : "/stations";
  }
  if (pathname === "/analytics" || pathname === "/buses/network") {
    return mode === "bus" ? "/buses/network" : "/analytics";
  }
  return mode === "bus" ? "/buses" : "/";
}
