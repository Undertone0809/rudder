import { describe, expect, it } from "vitest";
import { shouldPreserveAppDirectOpenDuringOrganizationChange } from "./apps-workspace";

describe("Apps workspace organization changes", () => {
  it("preserves a targeted App route while a fresh direct-open intent is pending", () => {
    expect(shouldPreserveAppDirectOpenDuringOrganizationChange(
      "managed:target-app",
      4,
    )).toBe(true);
  });

  it("resets ordinary organization changes and Apps home routes", () => {
    expect(shouldPreserveAppDirectOpenDuringOrganizationChange(
      "managed:target-app",
      0,
    )).toBe(false);
    expect(shouldPreserveAppDirectOpenDuringOrganizationChange("home", 4)).toBe(false);
  });
});
