import type { ReactNode } from "react";

export default function LiveMapShell({
  map,
  summary,
  children,
  hasSheet = false,
}: {
  map: ReactNode;
  summary: ReactNode;
  children?: ReactNode;
  hasSheet?: boolean;
}) {
  return (
    <div className={`map-shell${hasSheet ? " has-sheet" : ""}`}>
      {map}
      <div className="pointer-events-none absolute left-3 top-3 z-30 sm:left-4 sm:top-4">
        {summary}
      </div>
      {children}
    </div>
  );
}
