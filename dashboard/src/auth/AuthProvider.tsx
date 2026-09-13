import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ClerkProvider, useAuth as useClerkAuth, useClerk } from "@clerk/react";
import { useNavigate } from "react-router-dom";

import { api, type MeUser } from "../graphql/api";
import { AuthContext, type AuthContextValue } from "./AuthContext";
import { clerkAppearance } from "./clerkAppearance";
import { setTokenGetter } from "./token";

const noop = async () => {};

function AnonymousAuth({
  loading,
  error = null,
  refreshUser = noop,
  children,
}: {
  loading: boolean;
  error?: string | null;
  refreshUser?: () => Promise<void>;
  children: ReactNode;
}) {
  const value = useMemo<AuthContextValue>(
    () => ({
      user: null,
      signedIn: false,
      loading,
      enabled: false,
      billingEnabled: false,
      error,
      logout: noop,
      refreshUser,
      manageAccount: () => {},
    }),
    [error, loading, refreshUser],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// maps the clerk session onto our own account (plan role, billing)
function ClerkIdentityBridge({
  billingEnabled,
  children,
}: {
  billingEnabled: boolean;
  children: ReactNode;
}) {
  const { isLoaded, isSignedIn, userId, getToken, signOut } = useClerkAuth();
  const clerk = useClerk();
  const [user, setUser] = useState<MeUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);
  const userRef = useRef<MeUser | null>(null);

  const refreshUser = useCallback(async () => {
    const currentRequest = ++requestId.current;
    setLoading(userRef.current === null);
    setError(null);
    try {
      // Refresh the Clerk bearer token before reloading the local Polar plan.
      await getToken({ skipCache: true });
      const session = await api.session();
      if (currentRequest !== requestId.current) return;
      userRef.current = session.user;
      setUser(session.user);
      if (!session.user) {
        setError(
          "You’re signed in, but Traein couldn’t finish setting up your account. Try again in a moment.",
        );
      }
    } catch {
      if (currentRequest !== requestId.current) return;
      userRef.current = null;
      setUser(null);
      setError("Traein couldn’t load your account. Check your connection and try again.");
    } finally {
      if (currentRequest === requestId.current) setLoading(false);
    }
  }, [getToken]);

  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) {
      requestId.current += 1;
      setTokenGetter(null);
      userRef.current = null;
      return;
    }
    setTokenGetter(() => getToken());
    void refreshUser();
    return () => {
      requestId.current += 1;
      setTokenGetter(null);
    };
  }, [getToken, isLoaded, isSignedIn, refreshUser, userId]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user: isSignedIn ? user : null,
      signedIn: isSignedIn === true,
      loading: !isLoaded || (isSignedIn === true && loading),
      enabled: true,
      billingEnabled,
      error: isSignedIn ? error : null,
      logout: async () => {
        await signOut({ redirectUrl: "/" });
        requestId.current += 1;
        setTokenGetter(null);
        userRef.current = null;
        setUser(null);
        setError(null);
      },
      refreshUser,
      manageAccount: () => clerk.openUserProfile(),
    }),
    [billingEnabled, clerk, error, isLoaded, isSignedIn, loading, refreshUser, signOut, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function ClerkBridge({
  billingEnabled,
  children,
}: {
  billingEnabled: boolean;
  children: ReactNode;
}) {
  const { isLoaded, userId } = useClerkAuth();
  const identityKey = isLoaded ? (userId ?? "signed-out") : "loading";

  // A keyed boundary drops local account state and the URQL client before a
  // different Clerk identity can render with the previous user's role or cache.
  return (
    <ClerkIdentityBridge key={identityKey} billingEnabled={billingEnabled}>
      {children}
    </ClerkIdentityBridge>
  );
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const envKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;
  // undefined while the server config is loading, null when auth is off
  const [publishableKey, setPublishableKey] = useState<string | null | undefined>(
    envKey || undefined,
  );
  const [configError, setConfigError] = useState<string | null>(null);
  const [billingEnabled, setBillingEnabled] = useState(
    import.meta.env.VITE_POLAR_CHECKOUT_ENABLED === "true",
  );

  const loadConfig = useCallback((): Promise<void> => {
    if (envKey) return Promise.resolve();
    return api.config().then(
      (config) => {
        setPublishableKey(config.clerk_publishable_key ?? null);
        setBillingEnabled(config.billing_enabled === true);
        setConfigError(null);
      },
      () => {
        setPublishableKey(null);
        setBillingEnabled(false);
        setConfigError("Sign-in is temporarily unavailable. Try again in a moment.");
      },
    );
  }, [envKey]);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  if (publishableKey === undefined) {
    return <AnonymousAuth loading>{children}</AnonymousAuth>;
  }

  if (!publishableKey) {
    return (
      <AnonymousAuth loading={false} error={configError} refreshUser={loadConfig}>
        {children}
      </AnonymousAuth>
    );
  }

  return (
    <ClerkProvider
      publishableKey={publishableKey}
      routerPush={(to) => navigate(to)}
      routerReplace={(to) => navigate(to, { replace: true })}
      signInUrl="/login"
      signUpUrl="/register"
      signInFallbackRedirectUrl="/"
      signUpFallbackRedirectUrl="/"
      afterSignOutUrl="/"
      appearance={clerkAppearance}
      localization={{
        signIn: {
          start: {
            title: "Welcome back",
            titleCombined: "Welcome back",
            subtitle: "Log in for delay statistics, history and the rail assistant.",
            subtitleCombined: "Log in for delay statistics, history and the rail assistant.",
          },
          emailCode: {
            title: "Check your email",
            subtitle: "Enter the verification code we sent to your email.",
            formTitle: "Verification code",
            resendButton: "Resend code",
          },
        },
        signUp: {
          start: {
            title: "Create an account",
            titleCombined: "Create an account",
            subtitle: "Free accounts include live rail, bus departures and station boards.",
            subtitleCombined: "Free accounts include live rail, bus departures and station boards.",
          },
          emailCode: {
            title: "Check your email",
            subtitle: "Enter the verification code we sent to your email.",
            formTitle: "Verification code",
            formSubtitle: "Use the code in the email to finish creating your account.",
            resendButton: "Resend code",
          },
        },
      }}
    >
      <ClerkBridge billingEnabled={billingEnabled}>{children}</ClerkBridge>
    </ClerkProvider>
  );
}
