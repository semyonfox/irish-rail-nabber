export interface User {
  id: string;
  email: string;
  display_name: string | null;
  role: string;
}

export interface MeUser extends User {
  stripe_customer_id: string | null;
  created_at: string;
}

export interface SessionInfo {
  user: MeUser | null;
}

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

interface ApiErrorBody {
  error: string;
}

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
    ...init,
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({ error: "request failed" }))) as ApiErrorBody;
    throw new ApiError(response.status, body.error || "request failed");
  }

  const text = await response.text();
  return (text ? JSON.parse(text) : {}) as T;
}

export const api = {
  register(email: string, password: string, displayName?: string) {
    return request<User>("/auth/register", {
      method: "POST",
      body: JSON.stringify({
        email,
        password,
        display_name: displayName,
      }),
    });
  },

  login(email: string, password: string) {
    return request<User>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
  },

  logout() {
    return request<Record<string, never>>("/auth/logout", { method: "POST" });
  },

  refresh() {
    return request<User>("/auth/refresh", { method: "POST" });
  },

  me() {
    return request<MeUser>("/auth/me");
  },

  session() {
    return request<SessionInfo>("/auth/session");
  },

  checkout(price_id: string) {
    return request<{ url: string }>("/billing/checkout", {
      method: "POST",
      body: JSON.stringify({ price_id }),
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
    });
  },
};
