import type { ReactNode } from "react";
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
  return (
    <div
      className="float-card rise pointer-events-auto w-[min(300px,calc(100vw-24px))] p-4"
      aria-label="Live network summary"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="eyebrow">
          {live && <span className="live-dot" />}
          {status}
        </span>
        <span className="code">{detail}</span>
      </div>
      <div className="mt-3 flex items-baseline gap-2">
        <span className="text-[46px] font-semibold leading-none tracking-[-0.035em]">{count}</span>
        <span className="text-[15px] leading-tight text-ink-2">{caption}</span>
      </div>
      <div className="mt-4 grid grid-cols-3 gap-2">
        {stats.map((stat) => (
          <MiniStat key={stat.label} {...stat} />
        ))}
      </div>
      {children}
    </div>
  );
}
