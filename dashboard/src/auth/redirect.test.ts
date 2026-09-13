import { describe, expect, test } from "vite-plus/test";

import { authUrl, returnToFromSearch, safeReturnTo } from "./redirect";

describe("auth return paths", () => {
  test("keeps an internal destination including its query and hash", () => {
    const destination = "/chat?train=1E78#latest";

    expect(safeReturnTo(destination)).toBe(destination);
    expect(returnToFromSearch(`?return_to=${encodeURIComponent(destination)}`)).toBe(destination);
    expect(authUrl("/login", destination)).toBe(
      `/login?return_to=${encodeURIComponent(destination)}`,
    );
  });

  test.each(["https://example.com", "//example.com", "/\\example.com", "/login/factor-one"])(
    "rejects unsafe or recursive destination %s",
    (destination) => {
      expect(safeReturnTo(destination)).toBe("/");
      expect(authUrl("/register", destination)).toBe("/register");
    },
  );
});
