import { describe, expect, it } from "vitest";
import { resolveVerifiedIdentity } from "./account-linking.js";

describe("resolveVerifiedIdentity policy", () => {
  it("rejects unverified provider email before touching the database", async () => {
    await expect(
      resolveVerifiedIdentity({} as never, {
        provider: "github",
        providerSubject: "unverified-subject",
        email: "owner@example.com",
        emailVerified: false,
      }),
    ).rejects.toThrow("Unverified provider email");
  });
});
