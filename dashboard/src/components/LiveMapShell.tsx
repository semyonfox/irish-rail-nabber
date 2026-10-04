import type { ReactNode } from "react";

export default function LiveMapShell({
  map,
  summary,
  children,
  hasSheet = false,
  title,
}: {
  map: ReactNode;
  summary: ReactNode;
  children?: ReactNode;
  hasSheet?: boolean;
  title?: string;
}) {
  return (
    <div className={`map-shell${hasSheet ? " has-sheet" : ""}`}>
      {title ? <h1 className="sr-only">{title}</h1> : null}
      {map}
      <div className="map-summary pointer-events-none absolute left-3 top-3 z-30 sm:left-4 sm:top-4">
        {summary}
      </div>
      {children}
    </div>
  );
}
