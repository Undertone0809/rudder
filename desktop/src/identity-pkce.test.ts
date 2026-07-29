import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  createIdentityPkceRequest,
  openIdentityLoopbackCallback,
  type IdentityLoopbackCallback,
} from "./identity-pkce.js";

let callback: IdentityLoopbackCallback | null = null;

afterEach(async () => {
  await callback?.close();
  callback = null;
});

describe("identity PKCE", () => {
  it("creates an S256 verifier and matching challenge", () => {
    const request = createIdentityPkceRequest();
    const expectedChallenge = createHash("sha256")
      .update(request.verifier, "ascii")
      .digest("base64url");

    expect(request.method).toBe("S256");
    expect(request.verifier.length).toBeGreaterThanOrEqual(43);
    expect(request.challenge).toBe(expectedChallenge);
    expect(request.state.length).toBeGreaterThanOrEqual(32);
  });

  it("accepts one matching loopback callback", async () => {
    callback = await openIdentityLoopbackCallback({
      expectedState: "expected-state",
      timeoutMs: 5_000,
    });

    const response = await fetch(`${callback.redirectUri}?state=expected-state&code=authorization-code`);

    expect(response.status).toBe(200);
    await expect(callback.waitForCode).resolves.toBe("authorization-code");
  });

  it("does not consume the callback on a mismatched state", async () => {
    callback = await openIdentityLoopbackCallback({
      expectedState: "expected-state",
      timeoutMs: 5_000,
    });

    const rejected = await fetch(`${callback.redirectUri}?state=wrong-state&code=stolen-code`);
    const accepted = await fetch(`${callback.redirectUri}?state=expected-state&code=valid-code`);

    expect(rejected.status).toBe(400);
    expect(accepted.status).toBe(200);
    await expect(callback.waitForCode).resolves.toBe("valid-code");
  });
});
