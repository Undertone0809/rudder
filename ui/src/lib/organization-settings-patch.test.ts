import { describe, expect, it } from "vitest";
import { buildOrganizationGeneralPatch } from "./organization-settings-patch";

describe("buildOrganizationGeneralPatch", () => {
  it("builds only user-editable general settings", () => {
    const patch = buildOrganizationGeneralPatch({
      name: "Legacy Organization",
      description: "Updated description",
      brandColor: "#112233",
    });

    expect(patch).not.toHaveProperty("issuePrefix");
    expect(patch).toMatchObject({
      name: "Legacy Organization",
      description: "Updated description",
      brandColor: "#112233",
    });
  });
});
