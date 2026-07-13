import { describe, expect, it } from "vitest";
import { buildOrganizationGeneralPatch } from "./organization-settings-patch";

describe("buildOrganizationGeneralPatch", () => {
  it("does not resubmit an unchanged legacy Issue Key", () => {
    const patch = buildOrganizationGeneralPatch({
      name: "Legacy Organization",
      description: "Updated description",
      brandColor: "#112233",
      issuePrefix: "LEGACYISSUEKEYOVER12",
      persistedIssuePrefix: "LEGACYISSUEKEYOVER12",
    });

    expect(patch).not.toHaveProperty("issuePrefix");
    expect(patch).toMatchObject({
      name: "Legacy Organization",
      description: "Updated description",
      brandColor: "#112233",
    });
  });

  it("includes an explicitly changed Issue Key", () => {
    expect(buildOrganizationGeneralPatch({
      name: "Rudder",
      description: "",
      brandColor: null,
      issuePrefix: " R6 ",
      persistedIssuePrefix: "RUD",
    })).toMatchObject({ issuePrefix: "R6" });
  });
});
