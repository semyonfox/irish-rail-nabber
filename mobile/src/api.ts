import { z } from "zod";

import * as queries from "./queries";

const baseUrl = (
  process.env.EXPO_PUBLIC_API_URL?.trim() || "https://traein.semyon.ie"
).replace(/\/+$/, "");
const text = z.string().nullable();
const number = z.number().nullable();
const latitude = z.number().min(-90).max(90);
const longitude = z.number().min(-180).max(180);

const train = z.object({
  trainCode: z.string(),
  trainDate: text,
  latitude: latitude.nullable(),
  longitude: longitude.nullable(),
  trainStatus: text,
  direction: text,
  trainType: text,
  fetchedAt: text,
});

const station = z.object({
  stationCode: z.string(),
  stationDesc: z.string(),
  stationType: text,
  isDart: z.boolean().nullable(),
  latitude: latitude.nullable(),
  longitude: longitude.nullable(),
});

const stationEvent = z.object({
  trainCode: z.string(),
  origin: text,
  destination: text,
  trainType: text,
  direction: text,
  status: text,
  scheduledArrival: text,
  scheduledDeparture: text,
  expectedArrival: text,
  expectedDeparture: text,
  lateMinutes: number,
  dueIn: number,
  lastLocation: text,
});

const busStop = z.object({
  stopId: z.string(),
  stopCode: text,
  stopName: text,
  latitude: latitude.nullable(),
  longitude: longitude.nullable(),
});

const busVehicle = z.object({
  entityId: text,
  vehicleId: text,
  routeId: text,
  routeShortName: text,
  headsign: text,
  operatorName: text,
  latitude,
  longitude,
});

const busDeparture = z.object({
  entityId: text,
  tripId: text,
  routeId: text,
  routeShortName: text,
  routeLongName: text,
  operatorName: text,
  headsign: text,
  serviceDate: text,
  scheduledTime: text,
  expectedTime: text,
  delaySeconds: number,
  scheduleRelationship: text,
  fetchedAt: z.string(),
});

const me = z.object({
  id: z.string(),
  email: z.string(),
  display_name: text,
  role: z.string(),
});

export type Station = z.infer<typeof station>;
export type BusStop = z.infer<typeof busStop>;
export type TokenGetter = () => Promise<string | null>;

function decode<T>(schema: z.ZodType<T>, value: unknown) {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new Error("Traein returned an unexpected response.");
  return result.data;
}

type Limits = {
  anonymous: { until: number };
  signedIn: { until: number };
};

async function request(
  path: "/graphql" | "/auth/me",
  getToken: TokenGetter,
  signal: AbortSignal,
  limits: Limits,
  body?: string,
): Promise<unknown> {
  const headers = new Headers();
  if (body) headers.set("Content-Type", "application/json");
  let token: string | null = null;
  try {
    token = await getToken();
  } catch {
    // public data still works anonymously, only the account needs the token
    if (path === "/auth/me")
      throw new Error("Could not refresh your sign-in. Try again.");
  }
  if (!token && path === "/auth/me") {
    throw new Error("Could not refresh your sign-in. Try again.");
  }
  if (token) headers.set("Authorization", `Bearer ${token}`);

  // the api meters anonymous ips and signed-in users separately, so a 429 on
  // one must not lock out the other
  const limit = token ? limits.signedIn : limits.anonymous;
  if (path === "/graphql" && Date.now() < limit.until) {
    throw new Error("The API request limit has been reached. Try again later.");
  }

  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  const timeout = setTimeout(cancel, 15_000);
  try {
    const response = await fetch(baseUrl + path, {
      method: body ? "POST" : "GET",
      headers,
      body,
      signal: controller.signal,
      credentials: "omit",
    });
    if (response.status === 429) {
      if (path === "/graphql") {
        const reset = Number(response.headers.get("X-RateLimit-Reset")) * 1000;
        limit.until = Math.max(
          Date.now() + 300_000,
          Number.isFinite(reset) ? reset : 0,
        );
      }
      throw new Error(
        "The API request limit has been reached. Try again later.",
      );
    }
    if (response.status === 401 && path === "/auth/me") {
      throw new Error(
        "Traein did not accept this sign-in. Try again, or sign out and back in.",
      );
    }
    if (!response.ok)
      throw new Error("Traein could not load this data. Try again.");
    return await response.json();
  } catch (error) {
    if (controller.signal.aborted && !signal.aborted) {
      throw new Error("Traein took too long to respond. Try again.");
    }
    if (error instanceof TypeError) {
      throw new Error(
        "Could not reach Traein. Check your connection and try again.",
      );
    }
    if (error instanceof SyntaxError)
      throw new Error("Traein returned an unreadable response.");
    throw error;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", cancel);
  }
}

const envelope = z.object({
  data: z.record(z.string(), z.unknown()).nullish(),
  errors: z
    .array(
      z.object({
        path: z.array(z.union([z.string(), z.number()])).optional(),
      }),
    )
    .optional(),
});

export function createApi(getToken: TokenGetter) {
  const limits: Limits = { anonymous: { until: 0 }, signedIn: { until: 0 } };
  async function query(
    document: string,
    variables: Record<string, string | number>,
    signal: AbortSignal,
  ) {
    const response = await request(
      "/graphql",
      getToken,
      signal,
      limits,
      JSON.stringify({
        query: document,
        variables,
      }),
    );
    const parsed = decode(envelope, response);
    return (field: string) => {
      if (
        parsed.errors?.some(({ path }) => path == null || path[0] === field)
      ) {
        throw new Error("Traein could not load this data. Try again.");
      }
      return parsed.data?.[field];
    };
  }

  return {
    async trains(signal: AbortSignal) {
      const field = await query(queries.LIVE_TRAINS, {}, signal);
      return decode(z.array(train), field("liveTrains"));
    },
    async stations(signal: AbortSignal) {
      const field = await query(queries.STATIONS, {}, signal);
      return decode(z.array(station), field("stations"));
    },
    async stationBoard(stationCode: string, signal: AbortSignal) {
      const field = await query(
        queries.STATION_BOARD,
        { stationCode, limit: 60 },
        signal,
      );
      return decode(z.array(stationEvent), field("stationBoard"));
    },
    async busPositions(signal: AbortSignal) {
      // busRealtimeStatus is non-null, so if either field fails the whole
      // response is null and neither is usable on its own
      const field = await query(queries.BUS_VEHICLES, { limit: 2000 }, signal);
      const vehicles = decode(z.array(busVehicle), field("busVehicles"));
      const status = decode(
        z.object({ vehiclesLastSuccessAt: text }),
        field("busRealtimeStatus"),
      );
      return {
        vehicles,
        lastSuccess: status.vehiclesLastSuccessAt,
        receivedAt: Date.now(),
      };
    },
    async busStops(search: string, signal: AbortSignal) {
      const field = await query(
        queries.BUS_STOPS,
        { search, limit: 30 },
        signal,
      );
      return decode(z.array(busStop), field("busStops"));
    },
    async busBoard(stopId: string, signal: AbortSignal) {
      const field = await query(
        queries.BUS_STOP_BOARD,
        { stopId, limit: 30 },
        signal,
      );
      return decode(z.array(busDeparture), field("busStopBoard"));
    },
    async me(signal: AbortSignal) {
      return decode(me, await request("/auth/me", getToken, signal, limits));
    },
  };
}

export const dublinTime = new Intl.DateTimeFormat("en-IE", {
  timeZone: "Europe/Dublin",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function clock(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : dublinTime.format(date);
}
