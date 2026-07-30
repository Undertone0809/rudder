import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashSecurityEventIp } from "./security-events.js";

describe("hashSecurityEventIp", () => {
  it("is deterministic within one deployment key and unlinkable across keys", () => {
    const ip = "203.0.113.42";
    const first = hashSecurityEventIp(ip, "deployment-secret-one");
    expect(hashSecurityEventIp(ip, "deployment-secret-one")).toBe(first);
    expect(hashSecurityEventIp(ip, "deployment-secret-two")).not.toBe(first);
    expect(first).not.toBe(createHash("sha256").update(ip).digest("base64url"));
  });
});
