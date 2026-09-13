import { Navigate, useLocation } from "react-router-dom";

import { useAuth } from "./useAuth";
import { authUrl } from "./redirect";

export default function ProtectedRoute({
  children,
  requirePaid = false,
}: {
  children: React.ReactNode;
  requirePaid?: boolean;
}) {
  const { user, signedIn, loading, error, logout, refreshUser } = useAuth();
  const location = useLocation();

  if (loading) {
    return <div className="empty h-full">Checking your session…</div>;
  }

  if (error) {
    return (
      <div className="page">
        <div className="page-inner min-h-full justify-center">
          <div className="card mx-auto w-full max-w-lg p-8 text-center">
            <h1 className="font-display text-[40px] leading-none">Account unavailable</h1>
            <p className="mt-4 text-ink-2">{error}</p>
            <div className="mt-6 flex flex-wrap justify-center gap-2">
              {signedIn ? (
                <button type="button" onClick={() => void logout()} className="btn btn-quiet">
                  Sign out
                </button>
              ) : null}
              <button type="button" onClick={() => void refreshUser()} className="btn btn-primary">
                Try again
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!user) {
    const returnTo = `${location.pathname}${location.search}${location.hash}`;
    return <Navigate to={authUrl("/login", returnTo)} replace />;
  }

  if (requirePaid && !["coffee", "pro", "admin"].includes(user.role)) {
    return <Navigate to="/pricing" replace />;
  }

  return <>{children}</>;
}
