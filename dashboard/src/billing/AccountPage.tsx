import { useEffect, useState } from "react";

import { useAuth } from "../auth/useAuth";
import { api, ApiError, type UsageInfo } from "../graphql/api";

export default function AccountPage() {
  const { user, logout } = useAuth();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingUsage, setLoadingUsage] = useState(false);
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  const usageText = usage?.limit === null ? "Unlimited" : `${usage?.used ?? 0} / ${usage?.limit}`;
  const usageRemainingText =
    usage?.remaining === null ? "Unlimited" : `${usage?.remaining ?? 0} remaining today`;
  const usageResetText = usage
    ? `Resets ${new Date(usage.reset_at * 1000).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })}`
    : "";

  if (!user) return null;

  useEffect(() => {
    let active = true;
    setLoadingUsage(true);
    api
      .usage()
      .then((payload) => {
        if (active) {
          setUsage(payload);
        }
      })
      .catch(() => {
        if (active) {
          setUsage(null);
        }
      })
      .finally(() => {
        if (active) {
          setLoadingUsage(false);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  async function openPortal() {
    setError("");
    setLoading(true);
    try {
      const { url } = await api.portal();
      window.location.href = url;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "failed to open billing portal");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-xl px-6 py-10">
      <h2 className="text-2xl font-bold text-white">Account</h2>

      <div className="mt-6 space-y-4 rounded-xl border border-[var(--rail-border)] bg-[var(--rail-surface)] p-6">
        <section className="space-y-3">
          <h3 className="text-lg font-semibold text-white">Profile</h3>
          <div className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <p className="text-[var(--rail-muted)]">Email</p>
              <p className="mt-1 text-white">{user.email}</p>
            </div>
            <div>
              <p className="text-[var(--rail-muted)]">Plan</p>
              <p className="mt-1 text-white capitalize">{user.role}</p>
            </div>
            <div>
              <p className="text-[var(--rail-muted)]">Member since</p>
              <p className="mt-1 text-white">{new Date(user.created_at).toLocaleDateString()}</p>
            </div>
          </div>
        </section>

        <section className="space-y-3 border-t border-[var(--rail-border)] pt-4">
          <h3 className="text-lg font-semibold text-white">API usage today</h3>
          {loadingUsage ? (
            <p className="text-sm text-[var(--rail-muted)]">Loading usage…</p>
          ) : usage ? (
            <div className="space-y-2">
              <p className="text-white">{usageText} requests</p>
              <p className="text-sm text-[var(--rail-muted)]">{usageRemainingText}</p>
              <p className="text-xs text-[var(--rail-muted)]">{usageResetText}</p>
              {usage.limit !== null ? (
                <div className="h-2 w-full rounded-full bg-[var(--rail-input)]">
                  <div
                    className="h-2 rounded-full bg-[var(--rail-accent)] transition-all"
                    style={{
                      width:
                        usage.limit && usage.limit > 0
                          ? `${Math.min((usage.used / usage.limit) * 100, 100)}%`
                          : "0%",
                    }}
                  />
                </div>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-[var(--rail-red)]">Usage data unavailable.</p>
          )}
        </section>

        {error ? <p className="text-sm text-[var(--rail-red)]">{error}</p> : null}

        <div className="flex flex-wrap gap-3 pt-3">
          {user.stripe_customer_id ? (
            <button
              onClick={openPortal}
              disabled={loading}
              className="rounded border border-[var(--rail-border)] px-4 py-2 text-sm text-white disabled:opacity-60"
            >
              {loading ? "Opening..." : "Manage billing"}
            </button>
          ) : null}

          <button
            onClick={logout}
            className="rounded border border-[var(--rail-red)] px-4 py-2 text-sm text-[var(--rail-red)]"
          >
            Log out
          </button>
        </div>
      </div>
    </div>
  );
}
