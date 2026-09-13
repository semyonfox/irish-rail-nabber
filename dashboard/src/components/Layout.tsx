import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";

import { useAuth } from "../auth/useAuth";
import { transportLinks, transportModeForPath } from "./transportNavigation";
import { BrandMark, Icon } from "./ui";

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
    <span className="clock" aria-label="Dublin time">
      {clockFormat.format(now)}
    </span>
  );
}

function initials(name: string) {
  const parts = name.split(/[\s@.]+/).filter(Boolean);
  return (parts[0]?.[0] ?? "?").toUpperCase() + (parts[1]?.[0] ?? "").toUpperCase();
}

export default function Layout() {
  const { pathname } = useLocation();
  const { user, signedIn, loading, logout } = useAuth();
  const name = user ? user.display_name || user.email : "";
  const pathMode = transportModeForPath(pathname);
  const [lastTransportMode, setLastTransportMode] = useState(pathMode ?? "rail");
  const transportMode = pathMode ?? lastTransportMode;
  const links = transportLinks[transportMode];

  useEffect(() => {
    if (pathMode) setLastTransportMode(pathMode);
  }, [pathMode]);

  return (
    <div className="flex h-dvh flex-col">
      <header className="app-header" data-mode={transportMode}>
        <Link
          to={transportMode === "bus" ? "/buses" : "/"}
          className="brand"
          aria-label={`traein ${transportMode} home`}
        >
          <BrandMark />
          <span className="brand-copy">
            <span className="brand-word">traein</span>
            <span className="brand-sub">Irish public transport, live</span>
          </span>
        </Link>

        <nav className="transport-modes" aria-label="Transport mode">
          <Link
            to="/"
            className={`transport-mode${transportMode === "rail" ? " is-active" : ""}`}
            data-transport="rail"
            aria-current={transportMode === "rail" ? "true" : undefined}
          >
            Rail
          </Link>
          <Link
            to="/buses"
            className={`transport-mode${transportMode === "bus" ? " is-active" : ""}`}
            data-transport="bus"
            aria-current={transportMode === "bus" ? "true" : undefined}
          >
            Bus
          </Link>
        </nav>

        <nav className="nav" aria-label="Primary">
          {links.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              end={link.to === "/"}
              className={({ isActive }) => `nav-link${isActive ? " is-active" : ""}`}
            >
              <Icon name={link.icon} />
              {link.label}
            </NavLink>
          ))}
        </nav>

        <div className="header-actions">
          <NavLink
            to="/pricing"
            aria-label="Pricing"
            className={({ isActive }) => `utility-link${isActive ? " is-active" : ""}`}
          >
            <Icon name="tag" />
            <span>Pricing</span>
          </NavLink>
          <span className="live-pill hidden sm:inline-flex" title="Feeds updating">
            <span className="live-dot" />
            Live
            <DublinClock />
          </span>
          {loading ? null : user ? (
            <Link to="/account" className="account-link" title={name}>
              <span className="avatar">{initials(name)}</span>
              <span className="hidden max-w-40 truncate pr-2 lg:inline">{name}</span>
            </Link>
          ) : signedIn ? (
            <button type="button" onClick={() => void logout()} className="btn btn-quiet btn-sm">
              Sign out
            </button>
          ) : (
            <>
              <Link to="/login" className="btn btn-quiet btn-sm hidden sm:inline-flex">
                Log in
              </Link>
              <Link to="/register" className="btn btn-primary btn-sm">
                Get access
              </Link>
            </>
          )}
        </div>
      </header>

      <main className="min-h-0 flex-1">
        <Outlet />
      </main>
    </div>
  );
}
