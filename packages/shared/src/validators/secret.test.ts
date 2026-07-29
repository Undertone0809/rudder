import { describe, expect, it } from "vitest";
import {
  createSecretSchema,
  rotateSecretSchema,
  updateSecretSchema,
} from "./secret.js";

describe("secret validators", () => {
  it("rejects caller-supplied secret purpose and unknown mutation fields", () => {
    expect(createSecretSchema.safeParse({
      name: "API key",
      value: "secret",
      purpose: "managed_mcp_connection",
    }).success).toBe(false);
    expect(rotateSecretSchema.safeParse({
      value: "rotated",
      purpose: "managed_mcp_connection",
    }).success).toBe(false);
    expect(updateSecretSchema.safeParse({
      description: "changed",
      purpose: "user_managed",
    }).success).toBe(false);
  });
});
