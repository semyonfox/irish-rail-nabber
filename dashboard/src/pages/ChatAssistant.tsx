import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Link } from "react-router-dom";

import { useAuth } from "../auth/useAuth";
import { BrandMark, Empty, Icon } from "../components/ui";
import { api, type ChatResponse, type ChatToolCall } from "../graphql/api";
import { chatErrorMessage } from "./chatError";

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
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const canUseChat = isPaidRole(user?.role);
  const canSend = !loading && !authLoading && input.trim().length > 0 && canUseChat;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading]);

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = input.trim();
    if (!canSend || !trimmed) {
      return;
    }

    setMessages((current) => [...current, { id: makeId(), role: "user", text: trimmed }]);
    setInput("");
    setLoading(true);
    setError("");

    try {
      const reply: ChatResponse = await api.chat(trimmed);
      setMessages((current) => [
        ...current,
        {
          id: makeId(),
          role: "assistant",
          text: preview(reply.answer),
          tools: reply.tools,
          model: reply.model,
        },
      ]);
    } catch (err) {
      const message = chatErrorMessage(err);
      setError(message);
      setMessages((current) => [
        ...current,
        { id: makeId(), role: "assistant", text: message, error: true },
      ]);
    } finally {
      setLoading(false);
    }
  }

  function onComposerKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      formRef.current?.requestSubmit();
    }
  }

  if (authLoading) {
    return <Empty className="h-full">Checking your plan…</Empty>;
  }

  if (!canUseChat) {
    return (
      <div className="page">
        <div className="page-inner min-h-full justify-center">
          <div className="card rise mx-auto w-full max-w-xl p-8 text-center sm:p-10">
            <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-brand-soft text-brand">
              <Icon name="chat" className="h-6 w-6" />
            </span>
            <h1 className="display mt-5 font-display text-[44px] leading-none">
              Ask the <em>network</em>
            </h1>
            <p className="mx-auto mt-4 max-w-md text-ink-2">
              The rail assistant answers questions about arrivals, delays and route reliability
              using live and historical data. It’s included with Coffee Club and Pro.
            </p>
            <ul className="mx-auto mt-6 max-w-md space-y-2 text-left">
              {QUICK_PROMPTS.slice(0, 2).map((prompt) => (
                <li key={prompt} className="rounded-xl bg-wash px-4 py-3 text-[14px] text-ink-2">
                  “{prompt}”
                </li>
              ))}
            </ul>
            <div className="mt-7 flex justify-center">
              <Link to="/pricing" className="btn btn-primary btn-lg">
                See plans
                <Icon name="arrow" />
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} className="page min-h-0 flex-1">
        <div className="mx-auto flex max-w-3xl flex-col gap-7 px-4 py-10">
          <header className="rise">
            <p className="eyebrow">Assistant</p>
            <h1 className="page-title">
              Ask the <em>network</em>
            </h1>
            <p className="page-desc">
              Arrivals, delays, route reliability and station trends. Answers are grounded in live
              and stored train data.
            </p>
          </header>

          {messages.length === 0 ? (
            <div className="grid gap-2 sm:grid-cols-2">
              {QUICK_PROMPTS.map((prompt, index) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => setInput(prompt)}
                  className="card rise p-4 text-left text-[14px] text-ink-2 transition hover:text-ink hover:shadow-md"
                  style={{ "--i": index + 1 } as React.CSSProperties}
                >
                  {prompt}
                </button>
              ))}
            </div>
          ) : null}

          {messages.map((message) =>
            message.role === "user" ? (
              <div
                key={message.id}
                className="max-w-[85%] self-end whitespace-pre-wrap rounded-[20px] rounded-br-md bg-ink px-4 py-3 text-[15px] text-white"
              >
                {message.text}
              </div>
            ) : (
              <div key={message.id} className="flex gap-3">
                <BrandMark className="h-8 w-8 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-[13px] font-semibold">
                    Rail assistant
                    {message.model ? (
                      <span className="code font-normal">{message.model}</span>
                    ) : null}
                  </div>
                  <div
                    className={`mt-1 whitespace-pre-wrap text-[15px] leading-relaxed ${
                      message.error ? "tone-block px-4 py-3" : "text-ink"
                    }`}
                    data-tone={message.error ? "bad" : undefined}
                  >
                    {message.text}
                  </div>
                  {message.tools && message.tools.length > 0 ? (
                    <details className="mt-3 rounded-xl border border-line bg-card">
                      <summary className="cursor-pointer px-3 py-2 text-[13px] font-semibold text-ink-2">
                        Looked up {message.tools.length}{" "}
                        {message.tools.length === 1 ? "source" : "sources"}
                      </summary>
                      <div className="space-y-2 border-t border-line p-3">
                        {message.tools.map((tool) => (
                          <div key={`${message.id}-${tool.name}`}>
                            <div className="flex flex-wrap items-center gap-2 text-[13px]">
                              <span className="chip">{tool.name}</span>
                              <span className="text-muted">
                                {tool.rows} rows{tool.truncated ? ", truncated" : ""}
                              </span>
                            </div>
                            <p className="code mt-1">{formatToolArgs(tool.arguments)}</p>
                            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-wash p-2 font-mono text-[12px] text-ink-2">
                              {tool.result}
                            </pre>
                          </div>
                        ))}
                      </div>
                    </details>
                  ) : null}
                </div>
              </div>
            ),
          )}

          {loading ? (
            <div className="flex items-center gap-3" aria-live="polite">
              <BrandMark className="h-8 w-8 shrink-0" />
              <span className="typing" aria-label="Assistant is thinking">
                <span />
                <span />
                <span />
              </span>
            </div>
          ) : null}
        </div>
      </div>

      <div className="border-t border-line bg-paper/90 backdrop-blur">
        <form ref={formRef} onSubmit={sendMessage} className="mx-auto max-w-3xl px-4 py-4">
          <label htmlFor="chat-input" className="sr-only">
            Ask a question
          </label>
          <div className="card flex items-end gap-2 p-2 focus-within:shadow-[0_0_0_3px_rgb(11_107_77/0.15),var(--shadow-card)]">
            <textarea
              id="chat-input"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={onComposerKey}
              rows={2}
              placeholder="How late is the 10:10 from Heuston?"
              className="min-h-12 flex-1 resize-none bg-transparent px-2 py-1.5 text-[15px] outline-none placeholder:text-[#979d97]"
              disabled={loading}
            />
            <button
              type="submit"
              disabled={!canSend}
              className="btn btn-primary h-10 w-10 shrink-0 rounded-full p-0"
              aria-label="Send question"
            >
              <Icon name="up" />
            </button>
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[12.5px] text-muted">
            <span>Enter to send, Shift+Enter for a new line</span>
            {error && /request limit/i.test(error) ? (
              <Link to="/pricing" className="font-semibold text-brand">
                View plans
              </Link>
            ) : (
              <span>Answers use train data and live tools only</span>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
