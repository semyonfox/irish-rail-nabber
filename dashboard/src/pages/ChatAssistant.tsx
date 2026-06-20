import { useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";

import { useAuth } from "../auth/useAuth";
import { api, ApiError, type ChatResponse, type ChatToolCall } from "../graphql/api";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  tools?: ChatToolCall[];
  model?: string;
  error?: boolean;
}

const QUICK_PROMPTS = [
  "Which station is running the worst this week?",
  "How late is the next 10:10 from Heuston to Bray?",
  "What does route reliability look like from Dublin to Galway today?",
  "When is train 1E78 expected to arrive at Clontarf Road?",
];

function makeId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isPaidRole(role: string | null | undefined) {
  return role === "coffee" || role === "pro" || role === "admin";
}

function toolSummary(tool: ChatToolCall) {
  return `${tool.name} (${tool.rows} rows${tool.truncated ? ", truncated" : ""})`;
}

function formatToolArgs(args: Record<string, unknown>) {
  return Object.entries(args)
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join(", ");
}

function preview(text: string) {
  const normalized = text.trim();
  if (!normalized) {
    return "No readable output returned.";
  }
  return normalized;
}

export default function ChatAssistant() {
  const { user, loading: authLoading } = useAuth();
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "welcome",
      role: "assistant",
      text: "Ask me about Irish Rail arrivals, delays, routes, or network status. I can predict likely delay windows from recent history.",
    },
  ]);

  const canUseChat = isPaidRole(user?.role);

  const canSend = !loading && !authLoading && input.trim().length > 0 && canUseChat;

  const quickPrompts = useMemo(() => QUICK_PROMPTS, []);

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = input.trim();
    if (!canSend || !trimmed) {
      return;
    }

    const userMessage: ChatMessage = {
      id: makeId(),
      role: "user",
      text: trimmed,
    };
    setMessages((current) => [...current, userMessage]);
    setInput("");
    setLoading(true);
    setError("");

    try {
      const reply: ChatResponse = await api.chat(trimmed);
      const assistantMessage: ChatMessage = {
        id: makeId(),
        role: "assistant",
        text: preview(reply.answer),
        tools: reply.tools,
        model: reply.model,
      };
      setMessages((current) => [...current, assistantMessage]);
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : "Failed to get a reply from the model.";
      setError(message);
      setMessages((current) => [
        ...current,
        {
          id: makeId(),
          role: "assistant",
          text: message,
          error: true,
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  if (authLoading) {
    return (
      <div className="mx-auto max-w-5xl px-6 py-10">
        <div className="rounded border border-[var(--rail-border)] bg-[var(--rail-surface)] p-6">
          <p className="text-sm text-[var(--rail-muted)]">Checking permissions…</p>
        </div>
      </div>
    );
  }

  if (!canUseChat) {
    return (
      <div className="mx-auto flex min-h-[60vh] max-w-5xl flex-col justify-center px-6 py-10">
        <div className="rounded-xl border border-[var(--rail-border)] bg-[var(--rail-surface)] p-8">
          <h2 className="text-2xl font-semibold text-white">Chat is a paid feature</h2>
          <p className="mt-3 max-w-xl text-sm leading-relaxed text-[var(--rail-muted)]">
            Irish Rail AI chat is available on Coffee and Pro plans.
          </p>
          <p className="mt-2 text-sm text-[var(--rail-muted)]">
            Sign in with an upgraded role or continue on the free path for live maps and station
            tools.
          </p>
          <div className="mt-6 flex gap-3">
            <Link
              to="/pricing"
              className="rounded bg-[var(--rail-green)] px-4 py-2 text-sm font-semibold text-black"
            >
              Upgrade
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-[calc(100vh-4rem)] max-w-6xl flex-col px-4 py-6">
      <div className="mb-4 rounded-lg border border-[var(--rail-border)] bg-[var(--rail-surface)] px-4 py-3">
        <p className="text-xs uppercase tracking-[0.15em] text-[var(--rail-muted)]">AI Assistant</p>
        <h2 className="text-xl font-semibold text-white">Irish Rail Coach</h2>
        <p className="mt-1 text-sm text-[var(--rail-muted)]">
          Ask for arrivals, delays, route reliability, station trends, and live network status.
        </p>
      </div>

      <div className="mb-3 flex-1 overflow-auto rounded-lg border border-[var(--rail-border)] bg-[var(--rail-bg)] p-4">
        <div className="space-y-3">
          {messages.map((message) => (
            <div
              key={message.id}
              className={`rounded-lg border px-4 py-3 ${
                message.role === "user"
                  ? "border-[var(--rail-green)]/40 bg-[var(--rail-green)]/10"
                  : message.error
                    ? "border-[var(--rail-red)]/50 bg-[var(--rail-red)]/10"
                    : "border-[var(--rail-border)] bg-[var(--rail-surface)]"
              }`}
            >
              <p
                className={`text-xs font-semibold ${message.role === "user" ? "text-[var(--rail-green)]" : "text-[var(--rail-muted)]"}`}
              >
                {message.role === "user" ? "You" : "RailGPT"}
              </p>
              <p className="mt-1 whitespace-pre-wrap text-sm text-white">{message.text}</p>
              {message.model ? (
                <p className="mt-2 text-xs text-[var(--rail-muted)]">Model: {message.model}</p>
              ) : null}
              {message.tools && message.tools.length > 0 ? (
                <details className="mt-3">
                  <summary className="cursor-pointer text-sm text-[var(--rail-muted)]">
                    Tools used ({message.tools.length})
                  </summary>
                  <div className="mt-2 space-y-2">
                    {message.tools.map((tool) => (
                      <div
                        key={`${message.id}-${tool.name}`}
                        className="rounded border border-[var(--rail-border)] bg-[var(--rail-bg)] p-3"
                      >
                        <p className="text-sm font-semibold text-white">{toolSummary(tool)}</p>
                        <p className="mt-1 text-xs text-[var(--rail-muted)]">
                          Args: {formatToolArgs(tool.arguments)}
                        </p>
                        <pre className="mt-2 max-h-40 overflow-auto rounded border border-[var(--rail-border)] bg-black/20 p-2 text-xs whitespace-pre-wrap text-[var(--rail-muted)]">
                          {tool.result}
                        </pre>
                      </div>
                    ))}
                  </div>
                </details>
              ) : null}
            </div>
          ))}
        </div>
      </div>

      <div className="mb-2 flex flex-wrap gap-2">
        {quickPrompts.map((prompt) => (
          <button
            key={prompt}
            type="button"
            onClick={() => setInput(prompt)}
            className="rounded border border-[var(--rail-border)] bg-[var(--rail-surface)] px-3 py-1.5 text-left text-xs text-[var(--rail-muted)] transition hover:border-[var(--rail-green)]/60 hover:text-white"
            disabled={loading}
          >
            {prompt}
          </button>
        ))}
      </div>

      <form onSubmit={sendMessage} className="space-y-2">
        <label htmlFor="chat-input" className="sr-only">
          Ask a question
        </label>
        <textarea
          id="chat-input"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder='Try: "How late is the 10:10 from Heuston?"'
          className="min-h-24 w-full rounded-lg border border-[var(--rail-border)] bg-[var(--rail-surface)] p-3 text-sm text-white outline-none focus:border-[var(--rail-green)]"
          disabled={loading}
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <button
            type="submit"
            disabled={!canSend}
            className="rounded bg-[var(--rail-green)] px-4 py-2 text-sm font-semibold text-black disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? "Getting answer..." : "Ask RailGPT"}
          </button>
          <p className="text-xs text-[var(--rail-muted)]">
            Model is constrained to train data and live tooling.
          </p>
        </div>
      </form>

      {error ? <p className="mt-2 text-sm text-[var(--rail-red)]">{error}</p> : null}
    </div>
  );
}
