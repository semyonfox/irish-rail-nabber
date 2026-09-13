import { useEffect, type CSSProperties, type ReactNode } from "react";
import { delayTone, shortDelay } from "../utils/format";

const icons = {
  map: (
    <>
      <path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Z" />
      <path d="M9 4v14M15 6v14" />
    </>
  ),
  bus: (
    <>
      <path d="M6 17V6.5C6 4.6 7.6 3 9.5 3h5C16.4 3 18 4.6 18 6.5V17" />
      <path d="M6 10h12M8.5 6.5h7M7 17h10v2H7z" />
      <circle cx="8.5" cy="19.5" r="1.5" />
      <circle cx="15.5" cy="19.5" r="1.5" />
    </>
  ),
  activity: <path d="M3 12h4l3-8 4 16 3-8h4" />,
  pin: (
    <>
      <path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11Z" />
      <circle cx="12" cy="10" r="2.5" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  chat: <path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 4Z" />,
  tag: (
    <>
      <path d="M3 12V4h8l10 10-8 8Z" />
      <circle cx="7.5" cy="8" r="1.5" />
    </>
  ),
  x: <path d="M6 6l12 12M18 6 6 18" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.2-4.2" />
    </>
  ),
  pause: <path d="M9 5v14M15 5v14" />,
  play: <path d="M7 5v14l12-7Z" />,
  refresh: (
    <>
      <path d="M20 12a8 8 0 1 1-2.34-5.66" />
      <path d="M20 4v5h-5" />
    </>
  ),
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
  up: <path d="M12 19V5M5 12l7-7 7 7" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  lock: (
    <>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </>
  ),
  alert: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.5M12 16.5v.01" />
    </>
  ),
  sort: <path d="m8 9 4-4 4 4M8 15l4 4 4-4" />,
  sortUp: <path d="m7 14 5-5 5 5" />,
  sortDown: <path d="m7 10 5 5 5-5" />,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof icons;
export type Tone = "ok" | "warn" | "bad" | "brand" | "neutral" | "muted";

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {icons[name]}
    </svg>
  );
}

// a roundel with a sleeper-dotted track and a train on it
export function BrandMark({ className = "h-9 w-9" }: { className?: string }) {
  const track = "M7 24.5c5.5-.5 8.5-3.2 11-7.2s5.5-6.6 11-7.3";
  return (
    <svg viewBox="0 0 36 36" className={className} aria-hidden="true">
      <circle cx="18" cy="18" r="18" fill="var(--color-brand)" />
      <path
        d={track}
        fill="none"
        stroke="#fff"
        strokeOpacity=".22"
        strokeWidth="6.5"
        strokeLinecap="round"
      />
      <path
        d={track}
        fill="none"
        stroke="#fff"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray="0.1 3.4"
      />
      <circle cx="18.1" cy="17.3" r="3.3" fill="#fff" />
    </svg>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="rise flex flex-wrap items-end justify-between gap-6">
      <div className="min-w-0">
        <p className="eyebrow">{eyebrow}</p>
        <h1 className="page-title">{title}</h1>
        {description ? <p className="page-desc">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function Card({
  title,
  description,
  actions,
  children,
  className = "",
  index,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  index?: number;
}) {
  return (
    <section
      className={`card overflow-hidden ${index != null ? "rise" : ""} ${className}`}
      style={index != null ? ({ "--i": index } as CSSProperties) : undefined}
    >
      {title ? (
        <div className="card-head">
          <div className="min-w-0">
            <h2 className="card-title">{title}</h2>
            {description ? <p className="card-desc">{description}</p> : null}
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Kpi({
  label,
  value,
  detail,
  tone,
  index = 0,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  tone?: Tone;
  index?: number;
}) {
  return (
    <div className="card kpi rise" style={{ "--i": index } as CSSProperties}>
      <div className="kpi-label">
        {tone ? <span className="tone-dot" data-tone={tone} /> : null}
        {label}
      </div>
      <div className="kpi-value">{value}</div>
      {detail ? <div className="kpi-detail line-clamp-2">{detail}</div> : null}
    </div>
  );
}

export function MiniStat({
  label,
  value,
  tone,
  title,
}: {
  label: string;
  value: ReactNode;
  tone?: Tone;
  title?: string;
}) {
  return (
    <div className="mini" title={title}>
      <div className="mini-label">
        {tone ? <span className="tone-dot" data-tone={tone} /> : null}
        {label}
      </div>
      <div className="mini-value">{value}</div>
    </div>
  );
}

export function DelayPill({
  minutes,
  precise = false,
}: {
  minutes: number | null | undefined;
  precise?: boolean;
}) {
  return (
    <span className="pill" data-tone={delayTone(minutes)}>
      {shortDelay(minutes, precise)}
    </span>
  );
}

export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  label,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function SearchInput({
  value,
  onChange,
  placeholder,
  label,
  className = "",
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label: string;
  className?: string;
}) {
  return (
    <span className={`search ${className}`}>
      <Icon name="search" />
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={label}
        className="control"
      />
    </span>
  );
}

export function ChartLegend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="mb-3 flex flex-wrap gap-x-5 gap-y-1 text-[12.5px] text-ink-2">
      {items.map((item) => (
        <span key={item.label} className="inline-flex items-center gap-2">
          <i className="h-[3px] w-4 rounded-full" style={{ background: item.color }} />
          {item.label}
        </span>
      ))}
    </div>
  );
}

export function Empty({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`empty ${className}`}>{children}</div>;
}

export function Sheet({
  eyebrow,
  title,
  subtitle,
  label,
  onClose,
  children,
}: {
  eyebrow: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <aside className="sheet" aria-label={label}>
      <div className="sheet-head">
        <div className="min-w-0">
          <p className="eyebrow">{eyebrow}</p>
          <h2 className="sheet-title">{title}</h2>
          {subtitle ? <div className="sheet-sub">{subtitle}</div> : null}
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label={`Close ${label}`}>
          <Icon name="x" />
        </button>
      </div>
      <div className="sheet-body">{children}</div>
    </aside>
  );
}
