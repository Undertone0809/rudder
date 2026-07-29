import { describe, expect, it } from "vitest";
import { buildOrganizationGeneralPatch } from "./organization-settings-patch";

describe("buildOrganizationGeneralPatch", () => {
  it("only submits fields exposed by organization General settings", () => {
    const patch = buildOrganizationGeneralPatch({
      name: "  Legacy Organization  ",
      brandColor: "#112233",
    });

    expect(patch).not.toHaveProperty("issuePrefix");
    expect(patch).not.toHaveProperty("description");
    expect(patch).toEqual({
      name: "Legacy Organization",
      brandColor: "#112233",
    });
  });

  it("normalizes an empty brand color to null", () => {
    expect(buildOrganizationGeneralPatch({
      name: "Rudder",
      brandColor: "",
    })).toEqual({
      name: "Rudder",
      brandColor: null,
    });
  });
});
