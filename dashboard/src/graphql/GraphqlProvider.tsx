import { useMemo, type ReactNode } from "react";
import { Provider } from "urql";

import { useAuth } from "../auth/useAuth";
import { createClient } from "./client";

// a fresh client per signed-in identity, so results fetched anonymously (or as
// someone else) never linger in the cache after signing in or out
export default function GraphqlProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const client = useMemo(() => createClient(), [userId]);
  return <Provider value={client}>{children}</Provider>;
}
