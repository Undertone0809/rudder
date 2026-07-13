import { describe, expect, it } from "vitest";
import { portabilityTargetSchema } from "./organization-portability.js";

describe("portabilityTargetSchema", () => {
  it("normalizes an explicit new-organization Issue Key", () => {
    expect(portabilityTargetSchema.parse({
      mode: "new_organization",
      newOrganizationName: "Imported Rudder",
      newOrganizationIssueKey: " im7 ",
    })).toMatchObject({ newOrganizationIssueKey: "IM7" });
  });

  it("rejects an invalid new-organization Issue Key", () => {
    expect(() => portabilityTargetSchema.parse({
      mode: "new_organization",
      newOrganizationIssueKey: "7IM",
    })).toThrow(/Issue key must start with a letter/);
  });
});
