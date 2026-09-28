import { useState } from "react";
import { SignIn } from "@clerk/react";
import { useLocation } from "react-router-dom";

import AuthShell from "./AuthShell";
import { authUrl, returnToFromSearch } from "./redirect";
import { useAuth } from "./useAuth";

export default function LoginPage() {
  const { enabled, loading, error, refreshUser } = useAuth();
  const location = useLocation();
  const [returnTo] = useState(() => returnToFromSearch(location.search));

  return (
    <AuthShell
      title="Welcome back"
      subtitle="Log in for delay statistics, history and the rail assistant."
      hideHeading={enabled}
    >
      {enabled ? (
        <SignIn
          routing="path"
          path="/login"
          signUpUrl={authUrl("/register", returnTo)}
          fallbackRedirectUrl={returnTo}
        />
      ) : error ? (
        <div className="tone-block px-4 py-4 text-[14px]" data-tone="bad">
          <p>{error}</p>
          <button type="button" onClick={() => void refreshUser()} className="btn btn-quiet mt-3">
            Try again
          </button>
        </div>
      ) : (
        <p className="tone-block px-4 py-3 text-[14px]">
          {loading ? "Loading sign-in…" : "Sign-in isn’t configured on this server yet."}
        </p>
      )}
    </AuthShell>
  );
}
