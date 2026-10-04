import { expect, test } from "vite-plus/test";
import { delayLabel, shortDelay } from "./format";
test.each([
  [-2, "2m early", "2 min early"],
  [0, "On time", "On time"],
  [7, "+7m", "7 min late"],
  [null, "Unknown", "Delay unknown"],
] as const)("delay %s has a color-independent description", (delay, visible, spoken) => {
  expect(shortDelay(delay)).toBe(visible);
  expect(delayLabel(delay)).toBe(spoken);
});
