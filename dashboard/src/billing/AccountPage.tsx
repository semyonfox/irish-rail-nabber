import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { useAuth } from "../auth/useAuth";
import { Card, Empty, PageHeader } from "../components/ui";
import { api, ApiError, type UsageInfo } from "../graphql/api";

export default function AccountPage() {
  const { user, logout, manageAccount, refreshUser } = useAuth();
  const [searchParams] = useSearchParams();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingUsage, setLoadingUsage] = useState(true);
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  const checkoutSucceeded = searchParams.get("checkout") === "success";

  useEffect(() => {
    if (!checkoutSucceeded) return;

    let cancelled = false;
    const syncPlan = async () => {
      // Polar's state webhook can arrive shortly after checkout redirects back.
      for (const delay of [0, 1_000, 2_000, 4_000, 8_000]) {
        if (delay > 0) {
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
        if (cancelled) return;
        await refreshUser();
      }
    };

    void syncPlan();
    return () => {
      cancelled = true;
    };
  }, [checkoutSucceeded, refreshUser]);

  useEffect(() => {
    let active = true;
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
  }, [user?.role]);

  if (!user) return null;

  const usedPct =
    usage?.limit && usage.limit > 0 ? Math.min((usage.used / usage.limit) * 100, 100) : 0;
  const resetText = usage
    ? new Date(usage.reset_at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "";
  const firstName = (user.display_name || user.email.split("@")[0]).split(" ")[0];

  async function openPortal() {
    setError("");
    setLoading(true);
    try {
      const { url } = await api.portal();
      window.location.assign(url);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "failed to open billing portal");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="page">
      <div className="page-inner max-w-4xl">
        <PageHeader
          eyebrow="Account"
          title={
            <>
              Hello, <em>{firstName}</em>
            </>
          }
          description={user.email}
          actions={
            <>
              <button type="button" onClick={manageAccount} className="btn btn-quiet">
                Sign-in & security
              </button>
              <button type="button" onClick={logout} className="btn btn-danger">
                Log out
              </button>
            </>
          }
        />

        {error ? (
          <p role="alert" className="tone-block px-4 py-3 text-[14px]" data-tone="bad">
            {error}
          </p>
        ) : null}
        {checkoutSucceeded ? (
          <p className="tone-block px-4 py-3 text-[14px]" data-tone="good">
            Payment received. Your plan will appear here as soon as Polar confirms it.
          </p>
        ) : null}

        <div className="grid gap-4 md:grid-cols-2">
          <Card index={1} title="Profile">
            <dl className="card-body grid gap-4 text-[14.5px]">
              <div className="flex items-center justify-between gap-4 border-b border-line pb-4">
                <dt className="text-muted">Email</dt>
                <dd className="min-w-0 break-words text-right font-medium">{user.email}</dd>
              </div>
              <div className="flex items-center justify-between gap-4 border-b border-line pb-4">
                <dt className="text-muted">Plan</dt>
                <dd>
                  <span className="rounded-full bg-brand-soft px-2.5 py-1 text-[13px] font-semibold capitalize text-brand">
                    {user.role}
                  </span>
                </dd>
              </div>
              <div className="flex items-center justify-between gap-4">
                <dt className="text-muted">Member since</dt>
                <dd className="font-medium">
                  {new Date(user.created_at).toLocaleDateString("en-IE", {
                    day: "numeric",
                    month: "long",
                    year: "numeric",
                  })}
                </dd>
              </div>
            </dl>
          </Card>

          <Card index={2} title="Data usage today">
            <div className="card-body">
              {loadingUsage ? (
                <Empty className="!min-h-32">Loading usage…</Empty>
              ) : usage ? (
                <>
                  <div className="flex items-baseline gap-2">
                    <span className="text-[40px] font-semibold leading-none tracking-[-0.03em]">
                      {usage.used.toLocaleString()}
                    </span>
                    <span className="text-ink-2">
                      {usage.limit === null
                        ? "requests, no fixed daily cap"
                        : `of ${usage.limit.toLocaleString()} requests`}
                    </span>
                  </div>
                  {usage.limit !== null ? (
                    <div className="meter mt-4" data-tone={usedPct >= 80 ? "warn" : undefined}>
                      <span style={{ width: `${usedPct}%` }} />
                    </div>
                  ) : null}
                  <p className="mt-3 text-[13.5px] text-muted">
                    {usage.remaining === null
                      ? "No fixed daily cap. Fair use applies."
                      : `${usage.remaining.toLocaleString()} remaining`}{" "}
                    · resets at {resetText}
                  </p>
                </>
              ) : (
                <p className="text-[14px] text-bad">Usage data unavailable.</p>
              )}
            </div>
          </Card>
        </div>

        <Card index={3} title="Billing" description="Change plan or manage payment details">
          <div className="card-body flex flex-wrap gap-2">
            <Link to="/pricing" className="btn btn-quiet">
              Compare plans
            </Link>
            {user.can_manage_billing ? (
              <button
                type="button"
                onClick={openPortal}
                disabled={loading}
                className="btn btn-primary"
              >
                {loading ? "Opening…" : "Manage billing"}
              </button>
            ) : null}
          </div>
        </Card>
      </div>
    </div>
  );
}
