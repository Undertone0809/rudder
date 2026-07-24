import { describe, expect, it } from "vitest";
import { parseProviderWorkspaceScope } from "./oauth.js";

describe("managed MCP official provider workspace identity", () => {
  it("uses Linear organization and Notion bot workspace without falling back to actor ids", () => {
    expect(parseProviderWorkspaceScope("linear", {
      id: "linear-user-id",
      name: "Linear User",
      organization: { id: "linear-org-id", name: "Linear Workspace" },
    })).toMatchObject({ id: "linear-org-id", displayName: "Linear Workspace" });
    expect(parseProviderWorkspaceScope("notion", {
      id: "notion-bot-id",
      name: "Rudder Bot",
      type: "bot",
      bot: {
        workspace_id: "notion-workspace-id",
        workspace_name: "Notion Workspace",
      },
    })).toMatchObject({ id: "notion-workspace-id", displayName: "Notion Workspace" });
    expect(parseProviderWorkspaceScope("linear", {
      id: "linear-user-id",
      name: "Linear User",
    })).toBeNull();
    expect(parseProviderWorkspaceScope("notion", {
      id: "notion-bot-id",
      name: "Rudder Bot",
    })).toBeNull();
  });
});
