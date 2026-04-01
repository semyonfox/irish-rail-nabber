import { Link, NavLink, Outlet } from "react-router-dom";

import { useAuth } from "../auth/useAuth";

const links = [
  { to: "/", label: "Live Map" },
  { to: "/stations", label: "Stations" },
  { to: "/analytics", label: "Analytics" },
  { to: "/pricing", label: "Pricing" },
];

export default function Layout() {
  const { user, loading } = useAuth();

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-6 border-b border-[var(--rail-border)] bg-[var(--rail-surface)] px-6 py-3">
        <h1 className="text-lg font-bold tracking-tight text-white">Irish Rail</h1>
        <nav className="flex gap-4">
          {links.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              className={({ isActive }) =>
                `text-sm transition-colors ${
                  isActive
                    ? "text-[var(--rail-green)] font-medium"
                    : "text-[var(--rail-muted)] hover:text-white"
                }`
              }
            >
              {l.label}
            </NavLink>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3">
          {loading ? null : user ? (
            <Link to="/account" className="text-sm text-[var(--rail-muted)] hover:text-white">
              {user.display_name || user.email}
            </Link>
          ) : (
            <>
              <Link to="/login" className="text-sm text-[var(--rail-muted)] hover:text-white">
                Log in
              </Link>
              <Link
                to="/register"
                className="rounded bg-[var(--rail-green)] px-3 py-1.5 text-sm font-medium text-black"
              >
                Sign up
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
