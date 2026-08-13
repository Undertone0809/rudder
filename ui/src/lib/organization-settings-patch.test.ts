import { describe, expect, it } from "vitest";
import { buildOrganizationGeneralPatch } from "./organization-settings-patch";

describe("buildOrganizationGeneralPatch", () => {
  it("only submits fields exposed by organization General settings", () => {
    const patch = buildOrganizationGeneralPatch({
      name: "  Legacy Organization  ",
    });

    expect(patch).not.toHaveProperty("issuePrefix");
    expect(patch).not.toHaveProperty("description");
    expect(patch).toEqual({
      name: "Legacy Organization",
    });
  });
});
