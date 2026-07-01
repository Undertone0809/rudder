import { describe, expect, it } from "vitest";
import {
  buildLibrarySkillHref,
  legacySkillRouteToLibraryHref,
  SKILLS_LIBRARY_DIRECTORY_HREF,
} from "./skill-library-routes";

describe("skill Library routes", () => {
  it("builds Library deep links for organization skill files", () => {
    expect(buildLibrarySkillHref("skill-router")).toBe("/library?skill=skill-router&skillFile=SKILL.md");
    expect(buildLibrarySkillHref("skill-router", "references/route-selection.md")).toBe(
      "/library?skill=skill-router&skillFile=references%2Froute-selection.md",
    );
  });

  it("maps legacy Skills routes to Library links", () => {
    expect(legacySkillRouteToLibraryHref(undefined)).toBe(SKILLS_LIBRARY_DIRECTORY_HREF);
    expect(legacySkillRouteToLibraryHref("skill-router")).toBe("/library?skill=skill-router&skillFile=SKILL.md");
    expect(legacySkillRouteToLibraryHref("skill-router/files/references/route-selection.md")).toBe(
      "/library?skill=skill-router&skillFile=references%2Froute-selection.md",
    );
  });
});
