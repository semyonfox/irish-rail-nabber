import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { BrandMark } from "../components/ui";

// point on the highlighted track curve at t = 0.5
const TRAIN = { x: 255, y: 181 };

export default function AuthShell({
  title,
  subtitle,
  hideHeading = false,
  children,
  footer,
}: {
  title: ReactNode;
  subtitle: ReactNode;
  hideHeading?: boolean;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="grid h-full overflow-auto lg:grid-cols-[1.05fr_1fr]">
      <aside className="auth-art relative hidden overflow-hidden lg:block">
        <svg
          className="absolute inset-0 h-full w-full"
          viewBox="0 0 600 800"
          preserveAspectRatio="xMidYMid slice"
          aria-hidden="true"
        >
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <path
              key={i}
              d={`M-40 ${820 - i * 60} C 200 ${760 - i * 60}, 360 ${660 - i * 50}, 640 ${560 - i * 60}`}
              fill="none"
              stroke="#fff"
              strokeOpacity={0.06 + i * 0.015}
              strokeWidth="1.5"
            />
          ))}
          <path
            d="M-40 300 C 180 250, 300 120, 640 40"
            fill="none"
            stroke="#fff"
            strokeOpacity=".16"
            strokeWidth="14"
            strokeLinecap="round"
          />
          <path
            d="M-40 300 C 180 250, 300 120, 640 40"
            fill="none"
            stroke="#fff"
            strokeOpacity=".7"
            strokeWidth="3"
            strokeDasharray="0.5 12"
            strokeLinecap="round"
          />
          <circle cx={TRAIN.x} cy={TRAIN.y} r="22" fill="#fff" fillOpacity=".15" />
          <circle cx={TRAIN.x} cy={TRAIN.y} r="9" fill="#fff" />
        </svg>
        <div className="relative flex h-full flex-col justify-between p-12 text-white">
          <Link to="/" className="flex items-center gap-3 text-white no-underline">
            <BrandMark className="h-9 w-9 [&>circle:first-child]:fill-white/15" />
            <span className="font-display text-[30px] italic leading-none">traein</span>
          </Link>
          <div>
            <p className="font-display text-[60px] leading-[0.96] tracking-[-0.01em]">
              Ireland's public transport, <em>as it moves.</em>
            </p>
            <p className="mt-6 max-w-md text-[16px] text-white/75">
              Live rail positions, bus departures, station boards and months of delay history.
            </p>
          </div>
          <p className="text-[13px] text-white/55">
            Built on public realtime feeds from Iarnród Éireann and the NTA.
          </p>
        </div>
      </aside>

      <div className="flex items-center justify-center px-5 py-12">
        <div className="rise w-full max-w-sm">
          {hideHeading ? null : (
            <>
              <h1 className="font-display text-[46px] leading-none tracking-[-0.01em]">{title}</h1>
              <p className="mt-3 text-ink-2">{subtitle}</p>
            </>
          )}
          <div className={hideHeading ? undefined : "mt-8"}>{children}</div>
          {footer ? <p className="mt-6 text-center text-[14px] text-muted">{footer}</p> : null}
        </div>
      </div>
    </div>
  );
}
