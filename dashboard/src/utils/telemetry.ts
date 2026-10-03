export type TelemetryRoute = "app" | "home" | "login" | "settings" | "help" | "analysis" | "search";
type CountName = "app_open" | "screen_view" | "action_completed" | "action_failed";
type ErrorName = "request_failed";
interface PrivacySignals {
  globalPrivacyControl?: boolean;
  doNotTrack?: string | null;
}
interface Options {
  enabled?: boolean;
  endpoint?: string;
  optedOut: () => boolean;
  privacy: () => PrivacySignals;
  transport?: typeof fetch;
  now?: () => number;
}
const counts = new Set<unknown>(["app_open", "screen_view", "action_completed", "action_failed"]);
const routes = new Set<unknown>(["app", "home", "login", "settings", "help", "analysis", "search"]);
const preferenceKey = "traein-telemetry-disabled";
const budget = {
  total: 0,
  times: [] as number[],
  errors: new Map<string, number>(),
  inFlight: false,
};

function validEndpoint(endpoint: string | undefined): endpoint is string {
  if (!endpoint || /[\s\\?#]/u.test(endpoint)) return false;
  if (endpoint.startsWith("/")) return !endpoint.startsWith("//");
  try {
    const url = new URL(endpoint);
    return url.protocol === "https:" && !url.username && !url.password && !url.host.includes("@");
  } catch {
    return false;
  }
}

export function telemetryRoute(path: string): TelemetryRoute {
  if (path === "/" || path === "/buses") return "home";
  if (path === "/stations" || path === "/buses/stops") return "search";
  if (["/analytics", "/history", "/buses/network"].includes(path)) return "analysis";
  if (path === "/account") return "settings";
  if (
    path === "/login" ||
    path.startsWith("/login/") ||
    path === "/register" ||
    path.startsWith("/register/")
  )
    return "login";
  return "app";
}

export function telemetryOptedOut(): boolean {
  try {
    return window.localStorage.getItem(preferenceKey) === "true";
  } catch {
    return true;
  }
}

export function setTelemetryOptOut(disabled: boolean) {
  memoryOptOut = disabled;
  try {
    window.localStorage.setItem(preferenceKey, String(disabled));
  } catch {
    /* the in-memory opt-out still applies */
  }
}
let memoryOptOut = false;

export function createTelemetry(options: Options) {
  const endpoint = options.endpoint;
  const enabled = options.enabled === true && validEndpoint(endpoint);
  const transport = options.transport ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  function send(kind: "count" | "error", name: CountName | ErrorName, route: TelemetryRoute) {
    try {
      if (
        !enabled ||
        !endpoint ||
        !routes.has(route) ||
        !(kind === "count" ? counts.has(name) : name === "request_failed")
      )
        return;
      const privacy = options.privacy();
      if (
        options.optedOut() ||
        privacy.globalPrivacyControl === true ||
        privacy.doNotTrack === "1" ||
        privacy.doNotTrack === "yes"
      )
        return;
      if (budget.inFlight || budget.total >= 200) return;
      const time = now();
      if (!Number.isFinite(time) || time < 0) return;
      budget.times = budget.times.filter((sent) => time - sent < 60_000);
      const previous = budget.errors.get(route);
      if (
        budget.times.length >= 20 ||
        (kind === "error" && previous !== undefined && time - previous < 60_000)
      )
        return;
      budget.total++;
      budget.times.push(time);
      if (kind === "error") budget.errors.set(route, time);
      budget.inFlight = true;
      const controller = new AbortController();
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        budget.inFlight = false;
      };
      const timeout = setTimeout(() => {
        controller.abort();
        finish();
      }, 2000);
      try {
        const request = transport(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            version: 1,
            app: "irish-rail-nabber",
            kind,
            name,
            surface: "web",
            route,
          }),
          credentials: "omit",
          referrerPolicy: "no-referrer",
          redirect: "error",
          cache: "no-store",
          signal: controller.signal,
        });
        Promise.resolve(request).then(finish, finish);
      } catch {
        finish();
      }
    } catch {
      /* diagnostics must never interrupt the app */
    }
  }
  return {
    count: (name: CountName, route: TelemetryRoute = "app") => send("count", name, route),
    error: (name: ErrorName, route: TelemetryRoute = "app") => send("error", name, route),
  };
}

export const telemetryConfigured =
  import.meta.env.VITE_TELEMETRY_ENABLED === "true" &&
  validEndpoint(import.meta.env.VITE_TELEMETRY_ENDPOINT);
export const telemetry = createTelemetry({
  enabled: telemetryConfigured,
  endpoint: import.meta.env.VITE_TELEMETRY_ENDPOINT,
  optedOut: () => memoryOptOut || telemetryOptedOut(),
  privacy: () => ({
    globalPrivacyControl: Reflect.get(navigator, "globalPrivacyControl") === true,
    doNotTrack: navigator.doNotTrack,
  }),
});
