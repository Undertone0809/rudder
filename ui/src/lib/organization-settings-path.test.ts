import { describe, expect, it } from "vitest";

import { getOrganizationSettingsPath } from "./organization-settings-path";

describe("getOrganizationSettingsPath", () => {
  it("builds a prefixed organization settings route", () => {
    expect(getOrganizationSettingsPath("abc")).toBe("/ABC/organization/settings");
    expect(getOrganizationSettingsPath("  Team-1 ")).toBe("/TEAM-1/organization/settings");
  });
});
