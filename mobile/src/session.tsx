import { ClerkProvider, useAuth, useClerk } from "@clerk/clerk-expo";
import { tokenCache } from "@clerk/clerk-expo/token-cache";
import { createContext, useContext, useMemo, type ReactNode } from "react";

import { createApi } from "./api";

// off until the api accepts tokens from native apps, which carry no azp claim
export const accountEnabled = process.env.EXPO_PUBLIC_ENABLE_ACCOUNT === "true";
export const clerkKey = accountEnabled
  ? process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim()
  : undefined;

const publicApi = createApi(async () => null);
const ApiContext = createContext(publicApi);

function ApiProvider({ children }: { children: ReactNode }) {
  // clerk-expo's useAuth hands out a new getToken every render, which would
  // rebuild the api and wipe every screen's cache. the clerk instance is stable
  const clerk = useClerk();
  const { isSignedIn, userId } = useAuth();
  const api = useMemo(
    () =>
      isSignedIn && userId
        ? createApi(async () => (await clerk.session?.getToken()) ?? null)
        : publicApi,
    [clerk, isSignedIn, userId],
  );
  return <ApiContext.Provider value={api}>{children}</ApiContext.Provider>;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  if (!clerkKey) return children;

  return (
    <ClerkProvider publishableKey={clerkKey} tokenCache={tokenCache}>
      <ApiProvider>{children}</ApiProvider>
    </ClerkProvider>
  );
}

export function useApi() {
  return useContext(ApiContext);
}
