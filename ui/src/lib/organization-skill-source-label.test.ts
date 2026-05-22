import { describe, expect, it } from "vitest";
import {
  formatOrganizationSkillSourceLabel,
  formatOrganizationSkillSourceTooltip,
  resolveOrganizationSkillSourceCopyText,
} from "./organization-skill-source-label";

describe("organization-skill-source-label", () => {
  it("collapses local absolute paths to a short source label", () => {
    expect(
      formatOrganizationSkillSourceLabel({
        sourceBadge: "local",
        sourceLabel: "/Users/zeeland/projects/rudder-oss/.agents/skills/build-advisor",
        fallbackLabel: "Folder",
      }),
    ).toBe("Local folder");
  });

  it("keeps full local paths available as tooltip and copy text", () => {
    const input = {
      sourceBadge: "local" as const,
      sourceLabel: "/Users/zeeland/projects/rudder-oss/.agents/skills/build-advisor",
      sourceLocator: "/Users/zeeland/projects/rudder-oss/.agents/skills/build-advisor",
      sourcePath: null,
      fallbackLabel: "Folder",
    };

    expect(formatOrganizationSkillSourceTooltip(input)).toBe(
      "/Users/zeeland/projects/rudder-oss/.agents/skills/build-advisor",
    );
    expect(resolveOrganizationSkillSourceCopyText(input)).toBe(
      "/Users/zeeland/projects/rudder-oss/.agents/skills/build-advisor",
    );
  });

  it("keeps managed Rudder labels unchanged", () => {
    expect(
      formatOrganizationSkillSourceLabel({
        sourceBadge: "rudder",
        sourceLabel: "Bundled by Rudder",
        fallbackLabel: "Bundled by Rudder",
      }),
    ).toBe("Bundled by Rudder");
    expect(
      formatOrganizationSkillSourceTooltip({
        sourceBadge: "rudder",
        sourceLabel: "Bundled by Rudder",
        fallbackLabel: "Bundled by Rudder",
      }),
    ).toBeNull();
  });

  it("shortens plain URL source labels to the hostname", () => {
    expect(
      formatOrganizationSkillSourceLabel({
        sourceBadge: "url",
        sourceLabel: "https://example.com/skills/build-advisor/SKILL.md",
        fallbackLabel: "URL",
      }),
    ).toBe("example.com");
  });
});
