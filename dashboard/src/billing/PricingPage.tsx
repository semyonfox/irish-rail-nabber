import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { useAuth } from "../auth/useAuth";
import { api, ApiError, type RateLimits } from "../graphql/api";

const plans = [
  {
    id: "free",
    name: "Free",
    price: "EUR0",
    features: ["Live map", "Stations", "Limited API access"],
    priceId: "",
  },
  {
    id: "coffee",
    name: "Coffee Club",
    price: "EUR25/mo",
    features: ["Everything in Free", "Analytics", "Higher request limits"],
    priceId: import.meta.env.VITE_STRIPE_COFFEE_PRICE_ID || "",
  },
  {
    id: "pro",
    name: "Pro",
    price: "EUR75/mo",
    features: ["Everything in Coffee", "Unlimited requests", "Priority support"],
    priceId: import.meta.env.VITE_STRIPE_PRO_PRICE_ID || "",
  },
];

export default function PricingPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [loadingPlan, setLoadingPlan] = useState<string | null>(null);
  const [loadingLimits, setLoadingLimits] = useState(false);
  const [error, setError] = useState("");
  const [limits, setLimits] = useState<RateLimits | null>(null);

  const requestLimitText = (planId: string) => {
    if (!limits) {
      return "Loading limits...";
    }

    if (limits.unlimited_roles.includes(planId)) {
      return "Unlimited requests";
    }

    if (planId === "coffee") {
      return limits.coffee === null ? "Unlimited requests" : `Up to ${limits.coffee} requests/day`;
    }

    if (planId === "pro") {
      return "Unlimited requests";
    }

    if (planId === "free") {
      return limits.free === null ? "Unlimited requests" : `Up to ${limits.free} requests/day`;
    }

    return "Limited by plan";
  };

  useEffect(() => {
    let active = true;
    setLoadingLimits(true);
    api
      .limits()
      .then((payload) => {
        if (active) {
          setLimits(payload);
        }
      })
      .catch(() => {
        if (active) {
          setLimits(null);
        }
      })
      .finally(() => {
        if (active) {
          setLoadingLimits(false);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  async function startCheckout(priceId: string) {
    if (!user) {
      navigate("/register");
      return;
    }

    setLoadingPlan(priceId);
    setError("");

    try {
      const { url } = await api.checkout(priceId);
      window.location.href = url;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "failed to start checkout");
    } finally {
      setLoadingPlan(null);
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <h2 className="text-2xl font-bold text-white">Pricing</h2>
      <p className="mt-2 text-sm text-[var(--rail-muted)]">
        Pick a plan when you need deeper analytics access.
      </p>

      {error ? <p className="mt-4 text-sm text-[var(--rail-red)]">{error}</p> : null}

      <div className="mt-8 grid gap-4 md:grid-cols-3">
        {plans.map((plan) => {
          const current = user?.role === plan.id;
          const limitText = loadingLimits ? "Loading limits..." : requestLimitText(plan.id);

          return (
            <div
              key={plan.id}
              className="rounded-lg border border-[var(--rail-border)] bg-[var(--rail-surface)] p-5"
            >
              <h3 className="text-lg font-semibold text-white">{plan.name}</h3>
              <p className="mt-1 text-sm text-[var(--rail-muted)]">{plan.price}</p>
              <p className="mt-2 text-sm text-[var(--rail-muted)]">Requests: {limitText}</p>
              <ul className="mt-4 space-y-2 text-sm text-[var(--rail-muted)]">
                {plan.features.map((feature) => (
                  <li key={feature}>+ {feature}</li>
                ))}
              </ul>
              <div className="mt-6">
                {current ? (
                  <span className="text-sm font-medium text-[var(--rail-green)]">Current plan</span>
                ) : plan.priceId ? (
                  <button
                    onClick={() => startCheckout(plan.priceId)}
                    disabled={loadingPlan !== null}
                    className="w-full rounded bg-[var(--rail-green)] py-2 text-sm font-semibold text-black disabled:opacity-60"
                  >
                    {loadingPlan === plan.priceId ? "Redirecting..." : "Subscribe"}
                  </button>
                ) : (
                  <span className="text-sm text-[var(--rail-muted)]">No checkout needed</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
