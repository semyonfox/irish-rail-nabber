import { useEffect, useRef } from "react";
import { useQuery, type AnyVariables, type DocumentInput } from "urql";

// urql doesn't have a built-in pollInterval, so we roll our own
// by re-executing the query on an interval.
export function usePollingQuery<
  Data = unknown,
  Variables extends AnyVariables = AnyVariables,
>(opts: {
  query: DocumentInput<Data, Variables>;
  variables?: Variables;
  pause?: boolean;
  pollInterval?: number;
}) {
  const [result, reexecute] = useQuery<Data, Variables>({
    query: opts.query,
    variables: opts.variables as Variables,
    requestPolicy: "cache-first",
    pause: opts.pause,
  });

  const fetchingRef = useRef(result.fetching);
  fetchingRef.current = result.fetching;

  useEffect(() => {
    if (!opts.pollInterval || opts.pause) return;

    let timeout: ReturnType<typeof setTimeout>;
    const schedule = () => {
      // Small jitter prevents every mounted widget and browser tab from
      // hammering the API at the same instant.
      const jitter = 0.9 + Math.random() * 0.2;
      timeout = setTimeout(poll, opts.pollInterval! * jitter);
    };
    const poll = () => {
      if (document.visibilityState === "visible" && navigator.onLine && !fetchingRef.current) {
        reexecute({ requestPolicy: "network-only" });
      }
      schedule();
    };
    const resume = () => {
      if (document.visibilityState === "visible" && navigator.onLine && !fetchingRef.current) {
        reexecute({ requestPolicy: "network-only" });
      }
    };

    schedule();
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("online", resume);

    return () => {
      clearTimeout(timeout);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("online", resume);
    };
  }, [opts.pollInterval, opts.pause, reexecute]);

  return [result, reexecute] as const;
}
