import { describe, expect, it } from "vitest";
import { isOrganizationIntelligenceEnabled } from "./organization-intelligence";

describe("isOrganizationIntelligenceEnabled", () => {
  it("treats the canonical default as enabled for every legacy feature class", () => {
    const profiles = [{ purpose: "default", status: "configured" }] as const;
    expect(isOrganizationIntelligenceEnabled(profiles, "lightweight")).toBe(true);
    expect(isOrganizationIntelligenceEnabled(profiles, "reasoning")).toBe(true);
  });

  it("keeps legacy-only responses readable during rollout", () => {
    expect(isOrganizationIntelligenceEnabled(
      [{ purpose: "lightweight", status: "configured" }] as const,
      "lightweight",
    )).toBe(true);
    expect(isOrganizationIntelligenceEnabled(
      [{ purpose: "reasoning", status: "configured" }] as const,
      "lightweight",
    )).toBe(false);
  });
});

describe("canonical organization intelligence precedence", () => {
  it.each(["disabled", "invalid"] as const)("does not revive a %s default through a legacy alias", (status) => {
    const profiles = [
      { purpose: "default", status },
      { purpose: "lightweight", status: "configured" },
      { purpose: "reasoning", status: "configured" },
    ] as const;
    expect(isOrganizationIntelligenceEnabled(profiles, "lightweight")).toBe(false);
    expect(isOrganizationIntelligenceEnabled(profiles, "reasoning")).toBe(false);
  });
});
