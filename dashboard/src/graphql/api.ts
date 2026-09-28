import { authHeaders } from "../auth/token";

export interface User {
  id: string;
  email: string;
  display_name: string | null;
  role: string;
}

export interface MeUser extends User {
  can_manage_billing: boolean;
  created_at: string;
}

export interface SessionInfo {
  user: MeUser | null;
}

export interface AuthConfig {
  clerk_publishable_key: string | null;
  billing_enabled: boolean;
}

export type PaidPlan = "coffee" | "pro";

export interface UsageInfo {
  used: number;
  limit: number | null;
  remaining: number | null;
  reset_at: number;
  role: string;
}

export interface RateLimits {
  free: number | null;
  coffee: number | null;
  pro: number | null;
  unlimited_roles: string[];
}

export interface ChatToolCall {
  name: string;
  arguments: Record<string, unknown>;
  rows: number;
  truncated: boolean;
  result: string;
}

export interface ChatResponse {
  answer: string;
  tools: ChatToolCall[];
  model: string;
}

interface RequestOptions extends RequestInit {
  timeoutMs?: number;
}

export class ApiError extends Error {
  status: number;
  code: string | null;

  constructor(status: number, message: string, code: string | null = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init: RequestOptions = {}): Promise<T> {
  const { timeoutMs = 15_000, signal: callerSignal, ...fetchInit } = init;
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(callerSignal?.reason);

  if (callerSignal?.aborted) {
    abortFromCaller();
  } else {
    callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  }

  let timeout: ReturnType<typeof setTimeout>;
  const timedOut = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new ApiError(408, "request timed out"));
    }, timeoutMs);
  });

  const pending = (async () => {
    const response = await fetch(path, {
      credentials: "include",
      ...fetchInit,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(await authHeaders()),
        ...fetchInit.headers,
      },
    });

    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      const record = typeof body === "object" && body !== null ? body : null;
      const message =
        record && "error" in record && typeof record.error === "string"
          ? record.error
          : "request failed";
      const code =
        record && "code" in record && typeof record.code === "string" ? record.code : null;
      throw new ApiError(response.status, message, code);
    }

    const text = await response.text();
    return (text ? JSON.parse(text) : {}) as T;
  })();

  try {
    return await Promise.race([pending, timedOut]);
  } finally {
    clearTimeout(timeout!);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}

// sign-in and sign-up are handled by clerk; the api only knows the app account
export const api = {
  config() {
    return request<AuthConfig>("/auth/config");
  },

  me() {
    return request<MeUser>("/auth/me");
  },

  session() {
    return request<SessionInfo>("/auth/session");
  },

  checkout(plan: PaidPlan) {
    return request<{ url: string }>("/billing/checkout", {
      method: "POST",
      body: JSON.stringify({ plan }),
    });
  },

  portal() {
    return request<{ url: string }>("/billing/portal", {
      method: "POST",
    });
  },

  usage() {
    return request<UsageInfo>("/billing/usage");
  },

  limits() {
    return request<RateLimits>("/billing/limits");
  },

  chat(message: string) {
    return request<ChatResponse>("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message }),
      // The API stops model/tool work at 110s. Leave enough time to receive its
      // timeout response before the browser gives up.
      timeoutMs: 120_000,
    });
  },
};
