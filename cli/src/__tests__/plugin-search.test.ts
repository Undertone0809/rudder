import type { RudderPluginDirectory } from "@rudderhq/shared";
import { describe, expect, it } from "vitest";
import { searchPluginDirectory } from "../commands/client/plugin.js";

const directory = {
  installed: [{
    id: "86f6573e-2707-438b-9334-696c91fd0856",
    name: "canva",
    displayName: "Canva",
    description: "Create and edit visual designs",
    publisher: "Canva",
    sourceLabel: "OpenAI plugins",
    components: [{ key: "canva-design", displayName: "Canva Design", type: "mcp" }],
  }],
  localApps: [{
    id: "local-1",
    appId: "app-1",
    name: "Campaign Builder",
    description: "Marketing campaign workspace",
    appKey: "campaign-builder",
  }],
  discover: [{
    reportId: "report-1",
    packageId: "package-1",
    name: "figma",
    displayName: "Figma",
    description: "Collaborative design",
    publisher: "Figma",
    sourceLabel: "Marketplace",
    category: "design",
    components: [{ key: "figma-assets", name: "Figma Assets", type: "skill" }],
  }],
  discoverSource: "configured",
} as unknown as RudderPluginDirectory;

describe("searchPluginDirectory", () => {
  it("matches installed plugins by display name and component metadata", () => {
    expect(searchPluginDirectory(directory, "CANVA").installed.map((plugin) => plugin.id))
      .toEqual(["86f6573e-2707-438b-9334-696c91fd0856"]);
    expect(searchPluginDirectory(directory, "canva-design").installed).toHaveLength(1);
  });

  it("searches local apps and discoverable plugins without mixing result groups", () => {
    expect(searchPluginDirectory(directory, "campaign")).toMatchObject({
      installed: [],
      localApps: [{ id: "local-1" }],
      discover: [],
    });
    expect(searchPluginDirectory(directory, "design").discover).toHaveLength(1);
  });
});
