import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function setup(enabled = true, endpoint = "/v1/events") {
  const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
  const mod = await import("./telemetry");
  const options = { enabled, endpoint, transport, privacy: () => ({}), optedOut: () => false };
  return { ...mod, options, transport, client: mod.createTelemetry(options) };
}
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("anonymous reporting", () => {
  test("requires explicit enable and owner endpoint", async () => {
    const { createTelemetry, options, transport } = await setup();
    for (const config of [
      { ...options, enabled: undefined },
      { ...options, enabled: false },
      { ...options, endpoint: undefined },
    ])
      createTelemetry(config).count("screen_view", "home");
    expect(transport).not.toHaveBeenCalled();
  });
  test.each([
    "//collector.invalid/v1/events",
    "http://collector.invalid/v1/events",
    "https://user:secret@collector.invalid/v1/events",
    "https://collector.invalid/v1/events?user=private",
    "/v1/events#private",
    "/\\collector.invalid",
  ])("rejects unsafe endpoint %s", async (endpoint) => {
    const { client, transport } = await setup(true, endpoint);
    client.error("request_failed");
    expect(transport).not.toHaveBeenCalled();
  });
  test("GPC, DNT and unreadable or disabled preferences fail closed", async () => {
    const { createTelemetry, options, transport } = await setup();
    for (const privacy of [
      { globalPrivacyControl: true },
      { doNotTrack: "1" },
      { doNotTrack: "yes" },
    ])
      createTelemetry({ ...options, privacy: () => privacy }).count("screen_view");
    createTelemetry({ ...options, optedOut: () => true }).error("request_failed");
    createTelemetry({
      ...options,
      optedOut: () => {
        throw new Error("private preference error");
      },
    }).count("screen_view");
    expect(transport).not.toHaveBeenCalled();
  });
  test("serializes only fixed fields, never search text, IDs, URLs or diagnostic objects", async () => {
    const { client, transport, telemetryRoute } = await setup();
    client.error(
      "request_failed",
      telemetryRoute("/stations?code=secret-person&query=private-text"),
    );
    const request = transport.mock.calls[0][1];
    expect(JSON.parse(String(request?.body))).toEqual({
      version: 1,
      app: "irish-rail-nabber",
      kind: "error",
      name: "request_failed",
      surface: "web",
      route: "app",
    });
    expect(request).toMatchObject({
      credentials: "omit",
      referrerPolicy: "no-referrer",
      redirect: "error",
      cache: "no-store",
      method: "POST",
    });
    expect(String(request?.body).length).toBeLessThan(1024);
    await flush();
    Reflect.apply(client.count, null, ["private-text", "search"]);
    Reflect.apply(client.error, null, [new Error("secret error"), "search"]);
    Reflect.apply(client.count, null, ["screen_view", "/stations/private-id"]);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  test("drops concurrent events and times out without retrying", async () => {
    const { createTelemetry, options } = await setup();
    const transport = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
    const client = createTelemetry({ ...options, transport });
    client.count("screen_view");
    client.error("request_failed");
    expect(transport).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(transport.mock.calls[0][1]?.signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(120000);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  test("transport rejection and synchronous throw do not escape app control flow", async () => {
    const { createTelemetry, options } = await setup();
    for (const transport of [
      vi.fn<typeof fetch>().mockRejectedValue(new Error("private failure")),
      vi.fn<typeof fetch>().mockImplementation(() => {
        throw new Error("private failure");
      }),
    ]) {
      const client = createTelemetry({ ...options, transport });
      expect(() => client.count("action_completed")).not.toThrow();
      await flush();
      expect(transport).toHaveBeenCalledTimes(1);
    }
  });
  test("deduplicates errors, limits twenty per minute and two hundred per lifetime across clients", async () => {
    const { createTelemetry, options, transport } = await setup();
    const client = createTelemetry(options);
    client.error("request_failed", "home");
    await flush();
    client.error("request_failed", "home");
    expect(transport).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 30; i++) {
      createTelemetry(options).count("screen_view");
      await flush();
    }
    expect(transport).toHaveBeenCalledTimes(20);
    for (let minute = 0; minute < 15; minute++) {
      await vi.advanceTimersByTimeAsync(60001);
      for (let i = 0; i < 20; i++) {
        client.count("screen_view");
        await flush();
      }
    }
    expect(transport).toHaveBeenCalledTimes(200);
  });
  test("stores only a boolean preference and honors it immediately", async () => {
    const { setTelemetryOptOut, telemetryOptedOut } = await setup();
    const storage = { getItem: vi.fn(() => "true"), setItem: vi.fn() };
    vi.stubGlobal("window", { localStorage: storage });
    setTelemetryOptOut(true);
    expect(storage.setItem).toHaveBeenCalledWith("traein-telemetry-disabled", "true");
    expect(telemetryOptedOut()).toBe(true);
    vi.stubGlobal("window", {
      get localStorage() {
        throw new Error("blocked");
      },
    });
    expect(telemetryOptedOut()).toBe(true);
  });
});
