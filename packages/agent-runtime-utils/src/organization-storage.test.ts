import { describe, expect, it } from "vitest";
import {
  assertUniqueOrganizationStorageKeys,
  resolveOrganizationLegacyStorageKey,
  resolveOrganizationStorageKey,
} from "./organization-storage.js";

describe("organization storage keys", () => {
  it("uses Rudder short IDs for UUID organization storage paths", () => {
    expect(resolveOrganizationStorageKey("87e2f140-3876-4d47-b1e0-71d1bcd772ac")).toBe("87e2f1403876");
  });

  it("preserves non-UUID path-safe organization ids", () => {
    expect(resolveOrganizationStorageKey("organization-1")).toBe("organization-1");
  });

  it("keeps the legacy key available for migrations and cleanup", () => {
    expect(resolveOrganizationLegacyStorageKey("87e2f140-3876-4d47-b1e0-71d1bcd772ac")).toBe(
      "87e2f140-3876-4d47-b1e0-71d1bcd772ac",
    );
  });

  it("detects UUID storage key collisions", () => {
    expect(() =>
      assertUniqueOrganizationStorageKeys([
        "87e2f140-3876-4d47-b1e0-71d1bcd772ac",
        "87e2f140-3876-4d48-b1e0-71d1bcd772ac",
      ]),
    ).toThrow("Organization storage key collision");
  });

  it("detects UUID and non-UUID storage key collisions", () => {
    expect(() =>
      assertUniqueOrganizationStorageKeys([
        "87e2f140-3876-4d47-b1e0-71d1bcd772ac",
        "87e2f1403876",
      ]),
    ).toThrow("Organization storage key collision");
  });
});
