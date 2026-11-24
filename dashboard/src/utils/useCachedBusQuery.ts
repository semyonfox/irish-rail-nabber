import { useCallback, useEffect, useMemo, useState } from "react";
import { createRequest, type AnyVariables, CombinedError, type DocumentInput } from "@urql/core";
import { useClient } from "urql";
import { decodeBusSnapshot, readBusSnapshot, writeBusSnapshot } from "./busCache";

interface QueryState<Data> {
  scope: string;
  data?: Data;
  savedAt?: number;
  fetching: boolean;
  error?: CombinedError;
  cached: boolean;
}

// Only public transport data belongs here. Account/access scope must be part of cacheScope.
export function useCachedBusQuery<Data>({
  query,
  variables,
  validate,
  cacheScope = "public",
  pollInterval = 60_000,
  pause = false,
  incremental,
}: {
  query: DocumentInput<NoInfer<Data>, AnyVariables>;
  variables: AnyVariables;
  validate: (value: unknown) => value is Data;
  cacheScope?: string;
  pollInterval?: number;
  pause?: boolean;
  incremental?: {
    variables: (current: Data | undefined) => AnyVariables;
    merge: (current: Data | undefined, incoming: Data) => Data;
  };
}) {
  const client = useClient();
  const request = createRequest(query, variables);
  const scope = `v2:${cacheScope}:${request.key}`;
  // The operation key represents the document and serialized variables.
  const stableRequest = useMemo(() => request, [request.key]);
  const [state, setState] = useState<QueryState<Data>>({ scope, fetching: true, cached: false });
  const [revision, setRevision] = useState(0);
  const retry = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    if (pause) return;
    let active = true;
    let received = false;
    let fetching = false;
    let subscription: { unsubscribe(): void } | undefined;
    let current: Data | undefined;
    const restored = readBusSnapshot(scope)
      .then((raw) => {
        const stored = decodeBusSnapshot(raw, validate);
        if (active && !received && stored) {
          current = stored.data;
          setState((previous) => ({
            scope,
            ...stored,
            fetching,
            cached: true,
            error: previous.scope === scope ? previous.error : undefined,
          }));
        }
      })
      .catch(() => undefined);

    const fetch = () => {
      if (fetching || !active) return;
      fetching = true;
      setState((previous) =>
        previous.scope === scope
          ? { ...previous, fetching: true }
          : { scope, fetching: true, cached: false },
      );
      subscription?.unsubscribe();
      subscription = client
        .query<Data>(
          stableRequest.query,
          { ...stableRequest.variables, ...incremental?.variables(current) },
          {
            requestPolicy: "network-only",
          },
        )
        .subscribe((result) => {
          if (!active) return;
          fetching = false;
          if (!result.error && validate(result.data)) {
            received = true;
            current = incremental ? incremental.merge(current, result.data) : result.data;
            const snapshot = { data: current, savedAt: Date.now() };
            setState({ scope, ...snapshot, fetching: false, cached: false });
            void writeBusSnapshot(scope, snapshot).catch(() => undefined);
          } else {
            setState((previous) => ({
              ...(previous.scope === scope ? previous : { scope, cached: false }),
              fetching: false,
              error:
                result.error ??
                new CombinedError({ networkError: new Error("Unexpected bus response") }),
              cached: previous.scope === scope && previous.data !== undefined,
            }));
          }
        });
    };
    if (incremental) void restored.then(fetch);
    else fetch();
    const resume = () => {
      if (document.visibilityState === "visible" && navigator.onLine) fetch();
    };
    const timer = pollInterval > 0 ? setInterval(resume, pollInterval) : undefined;
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("online", resume);
    return () => {
      active = false;
      subscription?.unsubscribe();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("online", resume);
    };
  }, [client, stableRequest, scope, validate, revision, pollInterval, pause, incremental]);

  const visible: QueryState<Data> =
    state.scope === scope ? state : { scope, fetching: true, cached: false };
  return { ...visible, retry };
}

export function useCachedBusPollingQuery<Data>(
  opts: Parameters<typeof useCachedBusQuery<Data>>[0],
) {
  const state = useCachedBusQuery(opts);
  const retry = useCallback((_options?: { requestPolicy: string }) => state.retry(), [state.retry]);
  return [state, retry] as const;
}
