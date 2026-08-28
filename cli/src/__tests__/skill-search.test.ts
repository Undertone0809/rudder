import type { OrganizationSkillListItem } from "@rudderhq/shared";
import { describe, expect, it } from "vitest";
import { searchOrganizationSkills } from "../commands/client/skill.js";

const skills = [{
  id: "skill-1",
  key: "org/canva-design",
  slug: "canva-design",
  name: "Canva Design",
  description: "Create visual campaign assets",
  sourceType: "plugin",
  sourceLocator: "plugin://canva",
  sourceRef: "main",
  sourceLabel: "Canva plugin",
  sourceBadge: "plugin",
  sourcePath: null,
}] as unknown as OrganizationSkillListItem[];

describe("searchOrganizationSkills", () => {
  it("matches skill identity, description, and source fields case-insensitively", () => {
    expect(searchOrganizationSkills(skills, "CANVA").map((skill) => skill.id)).toEqual(["skill-1"]);
    expect(searchOrganizationSkills(skills, "campaign")).toHaveLength(1);
    expect(searchOrganizationSkills(skills, "missing")).toEqual([]);
  });
});
