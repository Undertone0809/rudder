import { describe, expect, it } from "vitest";
import {
  createDesktopSignInIntent,
  resolveDesktopSignInIntent,
} from "./desktop-sign-in-intent.js";

const binding = {
  clientId: "rudder-desktop",
  codeChallenge: "a".repeat(43),
  redirectUri: "http://127.0.0.1:45831/callback",
  secret: "test-secret-with-enough-entropy",
  state: "state-with-enough-entropy",
};

describe("Desktop sign-in intent", () => {
  it("round-trips an email hint without exposing it in the opaque token", () => {
    const intent = createDesktopSignInIntent({
      ...binding,
      email: "Owner@Example.com",
      method: "email_otp",
      now: 1_000,
    });
    expect(intent).not.toContain("Owner");
    expect(intent).not.toContain("Example");
    expect(resolveDesktopSignInIntent({
      ...binding,
      intent,
      now: 2_000,
    })).toEqual({ email: "owner@example.com", method: "email_otp" });
  });

  it("rejects tampering, expiry, and a different PKCE binding", () => {
    const intent = createDesktopSignInIntent({
      ...binding,
      method: "google",
      now: 1_000,
    });
    expect(() => resolveDesktopSignInIntent({
      ...binding,
      intent: `${intent.slice(0, -1)}x`,
      now: 2_000,
    })).toThrow("invalid_request");
    expect(() => resolveDesktopSignInIntent({
      ...binding,
      intent,
      now: 301_001,
    })).toThrow("invalid_request");
    expect(() => resolveDesktopSignInIntent({
      ...binding,
      codeChallenge: "b".repeat(43),
      intent,
      now: 2_000,
    })).toThrow("invalid_request");
  });
});
