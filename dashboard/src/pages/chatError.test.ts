import { describe, expect, test } from "vite-plus/test";

import { ApiError } from "../graphql/api";
import { chatErrorMessage } from "./chatError";

describe("chat errors", () => {
  test("keeps Traein quota and provider throttling separate", () => {
    expect(chatErrorMessage(new ApiError(429, "rate limit exceeded"))).toMatch(
      /today’s request limit/i,
    );
    expect(
      chatErrorMessage(
        new ApiError(
          503,
          "the rail assistant's model provider is temporarily rate limited",
          "model_provider_rate_limited",
        ),
      ),
    ).toBe("The rail assistant's model provider is busy right now. Try again in a moment.");
  });

  test("uses one clear message for browser and API timeouts", () => {
    const expected = "The rail assistant took too long to reply. Try again.";

    expect(chatErrorMessage(new ApiError(408, "request timed out"))).toBe(expected);
    expect(chatErrorMessage(new ApiError(504, "upstream timed out", "chat_timeout"))).toBe(
      expected,
    );
  });
});
