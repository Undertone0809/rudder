import { describe, expect, it } from "vitest";
import { createBrowserPopupRateLimiter } from "./browser-popup-rate-limit.js";

describe("Browser popup rate limiter", () => {
  it("drops popup bursts and recovers after the bounded window", () => {
    let now = 1_000;
    const accept = createBrowserPopupRateLimiter({ maxPopups: 2, windowMs: 100, now: () => now });

    expect(accept()).toBe(true);
    expect(accept()).toBe(true);
    expect(accept()).toBe(false);
    now += 100;
    expect(accept()).toBe(true);
  });
});
