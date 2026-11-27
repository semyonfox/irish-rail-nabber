import { useState } from "react";
import { SignUp } from "@clerk/react";
import { useLocation } from "react-router-dom";

import AuthShell from "./AuthShell";
import { authUrl, returnToFromSearch } from "./redirect";
import { useAuth } from "./useAuth";

export default function RegisterPage() {
  const { enabled, loading, error, refreshUser } = useAuth();
  const location = useLocation();
  const [returnTo] = useState(() => returnToFromSearch(location.search));

  return (
    <AuthShell
      title="Create an account"
      subtitle="Free accounts include live rail, bus departures and station boards."
      hideHeading={enabled}
    >
      {enabled ? (
        <SignUp
          routing="path"
          path="/register"
          signInUrl={authUrl("/login", returnTo)}
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
          {loading ? "Loading sign-up…" : "Sign-up isn’t configured on this server yet."}
        </p>
      )}
    </AuthShell>
  );
}
