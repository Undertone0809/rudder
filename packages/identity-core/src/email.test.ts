import { describe, expect, it } from "vitest";
import { maskEmail, normalizeVerifiedEmail } from "./email.js";

describe("normalizeVerifiedEmail", () => {
  it("normalizes case, whitespace, and Unicode width", () => {
    expect(normalizeVerifiedEmail("  Alice＠Example.COM ")).toBe("alice@example.com");
  });

  it("does not apply provider-specific alias rules", () => {
    expect(normalizeVerifiedEmail("alice+work@gmail.com")).toBe("alice+work@gmail.com");
  });

  it("rejects malformed addresses and controls", () => {
    expect(() => normalizeVerifiedEmail("alice")).toThrow("Invalid verified email");
    expect(() => normalizeVerifiedEmail("a@example.com\n")).not.toThrow();
    expect(() => normalizeVerifiedEmail("a\nb@example.com")).toThrow("Invalid verified email");
  });
});

describe("maskEmail", () => {
  it("preserves enough context without exposing the full local part", () => {
    expect(maskEmail("alice@example.com")).toBe("al•••@example.com");
  });
});
