import type { RudderPluginDirectory } from "@rudderhq/shared";
import { describe, expect, it } from "vitest";
import { buildPluginMentionOptions, pluginManagedSkillIds } from "./plugin-mentions";

const directory = {
  installed: [
    {
      id: "plugin-1",
      displayName: "Research Kit",
      name: "research-kit",
      description: "Evidence workflows",
      publisher: "Rudder",
      enabled: true,
      lifecycleState: "installed",
      components: [
        { type: "skill", targetId: "skill-1" },
        { type: "skill", targetId: "skill-2" },
        { type: "mcp", targetId: "mcp-1" },
      ],
    },
    {
      id: "plugin-disabled",
      displayName: "Disabled Kit",
      name: "disabled-kit",
      description: null,
      publisher: null,
      enabled: false,
      lifecycleState: "installed",
      components: [{ type: "skill", targetId: "skill-3" }],
    },
  ],
} as RudderPluginDirectory;

describe("Plugin mention catalog", () => {
  it("exposes one enabled Plugin option instead of its component Skills", () => {
    expect(buildPluginMentionOptions(directory)).toEqual([
      expect.objectContaining({
        id: "plugin:plugin-1",
        kind: "plugin",
        name: "Research Kit",
        pluginCapabilityLabel: "2 Skills + 1 MCP",
      }),
    ]);
    expect([...pluginManagedSkillIds(directory)]).toEqual(["skill-1", "skill-2", "skill-3"]);
  });
});
