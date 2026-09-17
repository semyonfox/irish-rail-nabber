import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { useAuth } from "../auth/useAuth";
import { Icon, PageHeader } from "../components/ui";
import { api, ApiError, type PaidPlan, type RateLimits } from "../graphql/api";

interface Plan {
  id: "free" | PaidPlan;
  name: string;
  amount: string;
  period: string;
  blurb: string;
  features: string[];
  paidPlan: PaidPlan | null;
  featured?: boolean;
}

const plans: Plan[] = [
  {
    id: "free",
    name: "Free",
    amount: "€0",
    period: "",
    blurb: "Live rail and bus departures.",
    features: ["Live rail map", "Station and bus stop boards", "Daily data access"],
    paidPlan: null,
  },
  {
    id: "coffee",
    name: "Coffee Club",
    amount: "€5",
    period: "/month",
    blurb: "For regular commuters and the curious.",
    features: [
      "Everything in Free",
      "Rail analytics",
      "Rail assistant chat",
      "Higher daily request limit",
    ],
    paidPlan: "coffee",
    featured: true,
  },
  {
    id: "pro",
    name: "Pro",
    amount: "€25",
    period: "/month",
    blurb: "For heavier use across the dashboard.",
    features: ["Everything in Coffee", "No fixed daily cap; fair use applies", "Priority support"],
    paidPlan: "pro",
  },
];

export default function PricingPage() {
  const navigate = useNavigate();
  const { user, billingEnabled } = useAuth();
  const [loadingPlan, setLoadingPlan] = useState<string | null>(null);
  const [loadingLimits, setLoadingLimits] = useState(true);
  const [error, setError] = useState("");
  const [limits, setLimits] = useState<RateLimits | null>(null);

  const requestLimitText = (planId: string) => {
    if (!limits) {
      return "Request limits unavailable";
    }

    if (limits.unlimited_roles.includes(planId)) {
      return "No fixed daily cap. Fair use applies.";
    }

    if (planId === "coffee") {
      return limits.coffee === null
        ? "No fixed daily cap. Fair use applies."
        : `Up to ${limits.coffee.toLocaleString()} data requests a day`;
    }

    if (planId === "pro") {
      return limits.pro === null
        ? "No fixed daily cap. Fair use applies."
        : `Up to ${limits.pro.toLocaleString()} data requests a day`;
    }

    if (planId === "free") {
      return limits.free === null
        ? "No fixed daily cap. Fair use applies."
        : `Up to ${limits.free.toLocaleString()} data requests a day`;
    }

    return "Limited by plan";
  };

  useEffect(() => {
    let active = true;
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

  async function startCheckout(plan: PaidPlan) {
    if (!user) {
      navigate("/register");
      return;
    }
    if (user.role !== "free") {
      navigate("/account");
      return;
    }

    setLoadingPlan(plan);
    setError("");

    try {
      const { url } = await api.checkout(plan);
      window.location.assign(url);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "failed to start checkout");
    } finally {
      setLoadingPlan(null);
    }
  }

  return (
    <div className="page">
      <div className="page-inner max-w-5xl">
        <PageHeader
          eyebrow="Pricing"
          title={
            <>
              Pick your <em>line</em>
            </>
          }
          description="The live rail map, bus departures and station boards are free. Plans add rail analytics, the assistant and more daily data requests."
        />

        {error ? (
          <p role="alert" className="tone-block px-4 py-3 text-[14px]" data-tone="bad">
            {error}
          </p>
        ) : null}

        <div className="grid gap-4 md:grid-cols-3">
          {plans.map((plan, index) => {
            const current = user?.role === plan.id;
            const limitText = loadingLimits ? "Loading limits…" : requestLimitText(plan.id);
            const featured = plan.featured === true;

            return (
              <div
                key={plan.id}
                className={`card rise relative flex flex-col p-6 ${featured ? "bg-[#121814] text-white" : ""}`}
                style={{ "--i": index + 1 } as React.CSSProperties}
              >
                {featured ? (
                  <span className="mb-3 self-start rounded-full bg-white/12 px-2.5 py-1 text-[12px] font-semibold text-white">
                    Includes the assistant
                  </span>
                ) : null}
                <h2 className="text-[17px] font-semibold">{plan.name}</h2>
                <p className={`mt-1 text-[14px] ${featured ? "text-white/70" : "text-muted"}`}>
                  {plan.blurb}
                </p>
                <div className="mt-6 flex items-baseline gap-1">
                  <span className="font-display text-[56px] leading-none">{plan.amount}</span>
                  {plan.period ? (
                    <span className={featured ? "text-white/70" : "text-muted"}>{plan.period}</span>
                  ) : null}
                </div>
                {plan.paidPlan ? (
                  <p className={`mt-2 text-[12.5px] ${featured ? "text-white/60" : "text-muted"}`}>
                    Includes applicable taxes
                  </p>
                ) : null}
                <p className={`mt-3 text-[13.5px] ${featured ? "text-white/70" : "text-muted"}`}>
                  {limitText}
                </p>
                <ul className="mt-6 flex-1 space-y-2.5 text-[14.5px]">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex items-center gap-2.5">
                      <Icon
                        name="check"
                        className={`h-4 w-4 shrink-0 ${featured ? "text-[#7fd8b4]" : "text-brand"}`}
                      />
                      {feature}
                    </li>
                  ))}
                </ul>
                <div className="mt-8">
                  {current ? (
                    <span
                      className={`btn w-full cursor-default ${featured ? "bg-white/10 text-white" : "bg-brand-soft text-brand"}`}
                    >
                      Your current plan
                    </span>
                  ) : plan.paidPlan && billingEnabled ? (
                    <button
                      type="button"
                      onClick={() => plan.paidPlan && startCheckout(plan.paidPlan)}
                      disabled={loadingPlan !== null}
                      className={`btn w-full ${featured ? "btn-brand" : "btn-primary"}`}
                    >
                      {user && user.role !== "free"
                        ? "Manage current plan"
                        : loadingPlan === plan.paidPlan
                          ? "Redirecting…"
                          : `Choose ${plan.name}`}
                    </button>
                  ) : (
                    <span
                      className={`block text-center text-[13.5px] ${featured ? "text-white/60" : "text-muted"}`}
                    >
                      {plan.id === "free" ? "No card needed" : "Checkout not configured"}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
