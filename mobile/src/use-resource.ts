import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { AppState } from "react-native";

type Load<T> = (signal: AbortSignal) => Promise<T>;

type Snapshot<T> =
  | { kind: "loading"; data?: undefined; error?: undefined }
  | { kind: "ready"; data: T; error?: undefined }
  | { kind: "error"; data: T | undefined; error: string };

export function useResource<T>(
  load: Load<T>,
  options: { interval?: number; maxAge?: number } = {},
) {
  const { interval = 0, maxAge = interval } = options;
  const [result, setResult] = useState<{
    load: Load<T>;
    snapshot: Snapshot<T>;
  }>();
  const [refreshing, setRefreshing] = useState(false);
  const cache = useRef<{ load: Load<T>; data: T; at: number } | undefined>(
    undefined,
  );
  const runNow = useRef<(() => Promise<void>) | null>(null);

  useFocusEffect(
    useCallback(() => {
      let disposed = false;
      let job: { controller: AbortController; done: Promise<void> } | undefined;
      const currentCache = () =>
        cache.current?.load === load ? cache.current : undefined;

      function update() {
        if (
          disposed ||
          (AppState.currentState && AppState.currentState !== "active")
        ) {
          return Promise.resolve();
        }
        if (job) return job.done;
        const controller = new AbortController();
        const done = Promise.resolve()
          .then(() => load(controller.signal))
          .then(
            (data) => {
              if (controller.signal.aborted) return;
              cache.current = { load, data, at: Date.now() };
              setResult({ load, snapshot: { kind: "ready", data } });
            },
            (error: unknown) => {
              if (controller.signal.aborted) return;
              const message =
                error instanceof Error
                  ? error.message
                  : "Could not load this data.";
              setResult({
                load,
                snapshot: {
                  kind: "error",
                  data: currentCache()?.data,
                  error: message,
                },
              });
            },
          )
          .finally(() => {
            if (job?.controller === controller) job = undefined;
          });
        job = { controller, done };
        return done;
      }

      function fromCacheOrUpdate() {
        const existing = currentCache();
        if (!existing || Date.now() - existing.at >= maxAge) void update();
      }

      runNow.current = update;
      fromCacheOrUpdate();
      const timer =
        interval > 0 ? setInterval(() => void update(), interval) : undefined;
      const subscription = AppState.addEventListener("change", (state) => {
        if (state === "active") fromCacheOrUpdate();
        else {
          job?.controller.abort();
          job = undefined;
        }
      });

      return () => {
        disposed = true;
        runNow.current = null;
        job?.controller.abort();
        clearInterval(timer);
        subscription.remove();
      };
    }, [load, interval, maxAge]),
  );

  const refresh = useCallback(async () => {
    if (!runNow.current) return;
    setRefreshing(true);
    try {
      await runNow.current();
    } finally {
      setRefreshing(false);
    }
  }, []);

  const snapshot: Snapshot<T> =
    result?.load === load ? result.snapshot : { kind: "loading" };
  return { ...snapshot, refreshing, refresh };
}
