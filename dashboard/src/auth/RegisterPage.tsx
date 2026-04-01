import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";

import { ApiError } from "../graphql/api";
import { useAuth } from "./useAuth";

export default function RegisterPage() {
  const { register } = useAuth();
  const navigate = useNavigate();

  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      await register(email, password, displayName || undefined);
      navigate("/");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "registration failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-[calc(100vh-56px)] items-center justify-center px-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm space-y-4 rounded-lg border border-[var(--rail-border)] bg-[var(--rail-surface)] p-6"
      >
        <h2 className="text-xl font-bold text-white">Create account</h2>

        {error ? <p className="text-sm text-[var(--rail-red)]">{error}</p> : null}

        <div className="space-y-1">
          <label className="text-sm text-[var(--rail-muted)]">Display name</label>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className="w-full rounded border border-[var(--rail-border)] bg-[var(--rail-bg)] px-3 py-2 text-white"
          />
        </div>

        <div className="space-y-1">
          <label className="text-sm text-[var(--rail-muted)]">Email</label>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded border border-[var(--rail-border)] bg-[var(--rail-bg)] px-3 py-2 text-white"
          />
        </div>

        <div className="space-y-1">
          <label className="text-sm text-[var(--rail-muted)]">Password</label>
          <input
            type="password"
            minLength={8}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded border border-[var(--rail-border)] bg-[var(--rail-bg)] px-3 py-2 text-white"
          />
        </div>

        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded bg-[var(--rail-green)] py-2 font-medium text-black disabled:opacity-60"
        >
          {submitting ? "Creating account..." : "Create account"}
        </button>

        <p className="text-center text-sm text-[var(--rail-muted)]">
          Already have an account?{" "}
          <Link to="/login" className="text-[var(--rail-green)] hover:underline">
            Log in
          </Link>
        </p>
      </form>
    </div>
  );
}
