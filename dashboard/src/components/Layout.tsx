import { useEffect, useState } from "react";
import { Link, NavLink, Outlet } from "react-router-dom";

import { useAuth } from "../auth/useAuth";

const clockFormat = new Intl.DateTimeFormat("en-IE", {
  timeZone: "Europe/Dublin",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function DublinClock() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <span className="live-clock" aria-label="Dublin time">
      {clockFormat.format(now)} DUBLIN
    </span>
  );
}

const links = [
  { to: "/", label: "Live map", short: "MAP" },
  { to: "/stations", label: "Stations", short: "STN" },
  { to: "/analytics", label: "Live network", short: "LIVE" },
  { to: "/history", label: "History & graphs", short: "HIST" },
  { to: "/chat", label: "Assistant", short: "OPS" },
  { to: "/pricing", label: "Pricing", short: "PLN" },
];

function RailMark() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className="h-8 w-8">
      <rect x="5" y="3" width="22" height="23" rx="5" fill="currentColor" />
      <path d="M10 9h12v8H10z" fill="#07110d" />
      <path d="m11 29 3-4m7 4-3-4M10 21h12" stroke="currentColor" strokeWidth="2" />
      <circle cx="11" cy="21" r="1.5" fill="#07110d" />
      <circle cx="21" cy="21" r="1.5" fill="#07110d" />
    </svg>
  );
}

export default function Layout() {
  const { user, loading } = useAuth();

  return (
    <div className="app-shell flex h-screen flex-col">
      <header className="ops-header">
        <Link to="/" className="brand-lockup" aria-label="Railwatch operations home">
          <span className="text-[var(--rail-green)]">
            <RailMark />
          </span>
          <span>
            <span className="block text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--rail-muted)]">
              Irish rail network
            </span>
            <span className="block text-base font-bold uppercase tracking-[0.08em] text-white">
              Railwatch <span className="font-normal text-[var(--rail-green)]">Ops</span>
            </span>
          </span>
        </Link>

        <nav className="ops-nav" aria-label="Primary navigation">
          {links.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              end={link.to === "/"}
              className={({ isActive }) => `ops-nav-link ${isActive ? "is-active" : ""}`}
            >
              <span className="nav-code">{link.short}</span>
              <span>{link.label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-4">
          <div className="system-state hidden sm:flex">
            <span className="status-lamp" />
            <span>
              <strong>System live</strong>
              <small>Feeds updating</small>
            </span>
          </div>
          {loading ? null : user ? (
            <Link to="/account" className="operator-link">
              {user.display_name || user.email}
            </Link>
          ) : (
            <div className="flex items-center gap-2">
              <Link to="/login" className="operator-link hidden md:block">
                Log in
              </Link>
              <Link to="/register" className="access-button">
                Get access
              </Link>
            </div>
          )}
        </div>
      </header>

      <div className="ops-strip" aria-label="System status">
        <span>CONTROL DESK 01</span>
        <span className="strip-divider" />
        <span>ALL-IRELAND NETWORK</span>
        <span className="ml-auto hidden sm:inline">LIVE SERVICE MONITOR</span>
        <DublinClock />
      </div>

      <main className="min-h-0 flex-1">
        <Outlet />
      </main>
    </div>
  );
}
