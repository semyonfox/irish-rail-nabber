import { useEffect } from "react";
import { useQuery, type AnyVariables, type DocumentInput } from "urql";

// urql doesn't have a built-in pollInterval, so we roll our own
// by re-executing the query on an interval.
// uses cache-and-network for the base query to avoid infinite
// re-fetch loops (network-only never caches, so each re-render
// would trigger another fetch)
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
    requestPolicy: "cache-and-network",
    pause: opts.pause,
  });

  useEffect(() => {
    if (!opts.pollInterval || opts.pause) return;

    const id = setInterval(() => {
      reexecute({ requestPolicy: "network-only" });
    }, opts.pollInterval);

    return () => clearInterval(id);
  }, [opts.pollInterval, opts.pause, reexecute]);

  return [result, reexecute] as const;
}
