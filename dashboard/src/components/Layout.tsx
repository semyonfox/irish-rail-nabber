import { useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";

import { useAuth } from "../auth/useAuth";
import { useTheme } from "../theme";
import { transportLinks, transportModeForPath, transportModePath } from "./transportNavigation";
import { BrandMark, Icon } from "./ui";

function initials(name: string) {
  const parts = name.split(/[\s@.]+/).filter(Boolean);
  return (parts[0]?.[0] ?? "?").toUpperCase() + (parts[1]?.[0] ?? "").toUpperCase();
}

export default function Layout() {
  const { pathname } = useLocation();
  const { user, signedIn, loading, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const name = user ? user.display_name || user.email : "";
  const pathMode = transportModeForPath(pathname);
  const [lastTransportMode, setLastTransportMode] = useState(pathMode ?? "rail");
  const transportMode = pathMode ?? lastTransportMode;
  const links = transportLinks[transportMode];

  if (pathMode && pathMode !== lastTransportMode) {
    setLastTransportMode(pathMode);
  }

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
            to={transportModePath(pathname, "rail")}
            className={`transport-mode${transportMode === "rail" ? " is-active" : ""}`}
            data-transport="rail"
            aria-current={transportMode === "rail" ? "true" : undefined}
          >
            Rail
          </Link>
          <Link
            to={transportModePath(pathname, "bus")}
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
              end
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
          </span>
          <button
            type="button"
            className="icon-btn header-theme-toggle"
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
            aria-pressed={theme === "dark"}
            title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
            onClick={toggleTheme}
          >
            <Icon name={theme === "dark" ? "sun" : "moon"} />
          </button>
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
