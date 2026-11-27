import { useId, useState, type ReactNode } from "react";
import { MiniStat } from "./ui";

export default function LiveNetworkSummary({
  status,
  live,
  count,
  caption,
  detail,
  stats,
  children,
}: {
  status: string;
  live: boolean;
  count: number | string;
  caption: string;
  detail: string;
  stats: { label: string; value: number | string; tone?: "warn" | "bad"; title?: string }[];
  children?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();

  return (
    <div
      className="live-summary float-card rise pointer-events-auto p-4"
      data-expanded={expanded}
      aria-label="Live network summary"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="eyebrow">
          {live && <span className="live-dot" />}
          {status}
        </span>
        <span className="code">{detail}</span>
      </div>
      <div className="live-summary-count mt-3 flex items-baseline gap-2">
        <span className="text-[46px] font-semibold leading-none tracking-[-0.035em]">{count}</span>
        <span className="text-[15px] leading-tight text-ink-2">{caption}</span>
      </div>
      <button
        type="button"
        className="live-summary-toggle"
        aria-expanded={expanded}
        aria-controls={detailsId}
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? "Hide details" : "Show details"}
        <span aria-hidden="true">{expanded ? "−" : "+"}</span>
      </button>
      <div id={detailsId} className="live-summary-details">
        <div className="mt-4 grid grid-flow-col auto-cols-fr gap-2">
          {stats.map((stat) => (
            <MiniStat key={stat.label} {...stat} />
          ))}
        </div>
        {children}
      </div>
    </div>
  );
}
