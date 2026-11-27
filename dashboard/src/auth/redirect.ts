const DEFAULT_RETURN_TO = "/";

export function safeReturnTo(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    return DEFAULT_RETURN_TO;
  }

  if (value.includes("\\")) {
    return DEFAULT_RETURN_TO;
  }

  const pathname = value.split(/[?#]/, 1)[0];
  if (
    pathname === "/login" ||
    pathname.startsWith("/login/") ||
    pathname === "/register" ||
    pathname.startsWith("/register/")
  ) {
    return DEFAULT_RETURN_TO;
  }

  return value;
}

export function returnToFromSearch(search: string): string {
  return safeReturnTo(new URLSearchParams(search).get("return_to"));
}

export function authUrl(path: "/login" | "/register", returnTo: string): string {
  const safePath = safeReturnTo(returnTo);
  if (safePath === DEFAULT_RETURN_TO) {
    return path;
  }

  const params = new URLSearchParams({ return_to: safePath });
  return `${path}?${params.toString()}`;
}
