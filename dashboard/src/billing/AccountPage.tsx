import { useState } from "react";

import { useAuth } from "../auth/useAuth";
import { api, ApiError } from "../graphql/api";

export default function AccountPage() {
  const { user, logout } = useAuth();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  if (!user) return null;

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

      <div className="mt-6 space-y-3 rounded-lg border border-[var(--rail-border)] bg-[var(--rail-surface)] p-6">
        <p className="text-sm text-[var(--rail-muted)]">Email</p>
        <p className="text-white">{user.email}</p>

        <p className="text-sm text-[var(--rail-muted)]">Plan</p>
        <p className="text-white">{user.role}</p>

        <p className="text-sm text-[var(--rail-muted)]">Member since</p>
        <p className="text-white">{new Date(user.created_at).toLocaleDateString()}</p>

        {error ? <p className="text-sm text-[var(--rail-red)]">{error}</p> : null}

        <div className="flex gap-3 pt-3">
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
