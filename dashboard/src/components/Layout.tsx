import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";

import { useAuth } from "../auth/useAuth";
import { useTheme } from "../theme";
import { transportLinks, transportModeForPath, transportModePath } from "./transportNavigation";
import { BrandMark, Icon } from "./ui";
import HelpDialog from "./HelpDialog";
import { telemetry, telemetryRoute } from "../utils/telemetry";

function subscribeConnection(onChange: () => void) {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

function initials(name: string) {
  const parts = name.split(/[\s@.]+/).filter(Boolean);
  return (parts[0]?.[0] ?? "?").toUpperCase() + (parts[1]?.[0] ?? "").toUpperCase();
}

const popoverSupported =
  typeof HTMLElement !== "undefined" && Object.hasOwn(HTMLElement.prototype, "popover");

export default function Layout() {
  const { pathname } = useLocation();
  const online = useSyncExternalStore(
    subscribeConnection,
    () => navigator.onLine,
    () => true,
  );
  const { user, signedIn, loading, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const name = user ? user.display_name || user.email : "";
  const pathMode = transportModeForPath(pathname);
  const [lastTransportMode, setLastTransportMode] = useState(pathMode ?? "rail");
  const transportMode = pathMode ?? lastTransportMode;
  const isAdmin = user?.role === "admin";
  const links = transportLinks[transportMode];
  const layoutRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    const nav = navRef.current;
    const active = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (nav && active) {
      nav.scrollLeft =
        active.offsetLeft - nav.offsetLeft - (nav.clientWidth - active.clientWidth) / 2;
    }
  }, [isAdmin, pathname, transportMode]);
  useEffect(() => {
    const layout = layoutRef.current;
    const viewport = window.visualViewport;
    if (!layout || !viewport) return;

    // iOS can shrink the visual viewport without resizing CSS viewport units
    const resize = () => {
      if (viewport.scale === 1) {
        layout.style.setProperty("--visual-viewport-height", `${viewport.height}px`);
      }
    };
    resize();
    viewport.addEventListener("resize", resize);
    return () => viewport.removeEventListener("resize", resize);
  }, []);

  const [helpOpen, setHelpOpen] = useState(false);
  const previousPath = useRef(pathname);
  useEffect(() => {
    telemetry.count("screen_view", telemetryRoute(pathname));
    if (previousPath.current !== pathname) document.getElementById("main-content")?.focus();
    previousPath.current = pathname;
  }, [pathname]);

  if (pathMode && pathMode !== lastTransportMode) {
    setLastTransportMode(pathMode);
  }

  const [fallbackOpen, setFallbackOpen] = useState(false);
  // the fallback menu has no light dismiss, so close it on any navigation
  const [menuPath, setMenuPath] = useState(pathname);
  if (menuPath !== pathname) {
    setMenuPath(pathname);
    setFallbackOpen(false);
  }
  const closeMenu = () => {
    menuRef.current?.hidePopover?.();
    setFallbackOpen(false);
  };
  const primaryLinks = (
    <>
      {links.map((link) => (
        <NavLink
          key={link.to}
          to={link.to}
          // detail pages keep their section highlighted, the mode roots match exactly
          end={link.to === "/" || link.to === "/buses"}
          className={({ isActive }) => `nav-link${isActive ? " is-active" : ""}`}
        >
          <Icon name={link.icon} />
          <span>{link.label}</span>
          {link.paid ? <span className="paid-label">Paid</span> : null}
        </NavLink>
      ))}
      {isAdmin ? (
        <NavLink
          to="/insights"
          className={({ isActive }) => `nav-link${isActive ? " is-active" : ""}`}
        >
          <Icon name="activity" />
          <span>Insights</span>
        </NavLink>
      ) : null}
    </>
  );
  const utilityLinks = (
    <>
      <NavLink
        to="/pricing"
        aria-label="Pricing"
        onClick={closeMenu}
        className={({ isActive }) => `utility-link${isActive ? " is-active" : ""}`}
      >
        <Icon name="tag" />
        <span>Pricing</span>
      </NavLink>
      <button
        type="button"
        className="btn btn-quiet btn-sm"
        onClick={() => {
          closeMenu();
          setHelpOpen(true);
        }}
      >
        Help
      </button>
    </>
  );
  const accountLinks = (
    <>
      {loading ? null : user ? (
        <Link
          to="/account"
          onClick={closeMenu}
          className="account-link"
          title={name}
          aria-label={`Account for ${name}`}
        >
          <span className="avatar" aria-hidden="true">
            {initials(name)}
          </span>
          <span className="header-account-name hidden max-w-40 truncate pr-2 lg:inline">
            {name}
          </span>
        </Link>
      ) : signedIn ? (
        <button
          type="button"
          onClick={() => {
            closeMenu();
            void logout();
          }}
          className="btn btn-quiet btn-sm"
        >
          Sign out
        </button>
      ) : (
        <>
          <Link to="/login" onClick={closeMenu} className="btn btn-quiet btn-sm">
            Log in
          </Link>
          <Link to="/register" onClick={closeMenu} className="btn btn-primary btn-sm">
            Create free account
          </Link>
        </>
      )}
    </>
  );

  return (
    <div ref={layoutRef} className="app-layout flex h-dvh flex-col">
      <a
        href="#main-content"
        className="skip-link"
        onClick={() => document.getElementById("main-content")?.focus()}
      >
        Skip to main content
      </a>
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

        <nav ref={navRef} className="nav desktop-nav" aria-label="Primary">
          {primaryLinks}
        </nav>

        <div className="header-actions">
          <div className="desktop-actions">{utilityLinks}</div>
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
          <div className="desktop-actions">{accountLinks}</div>
          {popoverSupported ? (
            <button
              type="button"
              className="btn btn-quiet mobile-menu-toggle"
              popoverTarget={menuId}
            >
              Menu
            </button>
          ) : (
            // safari before 17 has no popover, so toggle a class instead
            <button
              type="button"
              className="btn btn-quiet mobile-menu-toggle"
              aria-controls={menuId}
              aria-expanded={fallbackOpen}
              onClick={() => setFallbackOpen((open) => !open)}
            >
              Menu
            </button>
          )}
          <div
            id={menuId}
            ref={menuRef}
            className={`mobile-menu${fallbackOpen ? " is-open" : ""}`}
            popover={popoverSupported ? "auto" : undefined}
            onClick={(event) => {
              if (event.target instanceof Element && event.target.closest("a"))
                setFallbackOpen(false);
            }}
          >
            {utilityLinks}
            {accountLinks}
          </div>
        </div>
      </header>

      {!online ? (
        <p role="status" className="connection-notice">
          You’re offline. Displayed transport data is last loaded. Reconnect to refresh.
        </p>
      ) : null}
      <main id="main-content" tabIndex={-1} className="min-h-0 min-w-0 flex-1">
        <Outlet />
      </main>
      <nav className="mobile-nav" aria-label="Primary" data-mode={transportMode}>
        {primaryLinks}
      </nav>
      {helpOpen ? <HelpDialog onClose={() => setHelpOpen(false)} /> : null}
    </div>
  );
}
