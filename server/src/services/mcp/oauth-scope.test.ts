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

  it("uses an honest opaque authorization subject for Linear's official user shape", () => {
    const selected = parseProviderWorkspaceScope("linear", {
      id: "linear-workspace-scoped-user-id",
      name: "Zeeland",
      email: "owner@example.test",
      teams: [
        { id: "team-rudder", name: "Rudder", key: "RUD" },
        { id: "team-zeeland", name: "Zeeland", key: "ZEE" },
      ],
    });

    expect(selected).toMatchObject({
      displayName: "Zeeland's Linear authorization",
      metadata: { scopeKind: "authorization_subject" },
    });
    expect(selected?.id).toMatch(/^linear-authorization-subject-[a-f0-9]{24}$/u);
    expect(selected?.id).not.toContain("linear-workspace-scoped-user-id");
    expect(parseProviderWorkspaceScope("linear", {
      id: "linear-workspace-scoped-user-id",
      name: "Zeeland",
      teams: [{ id: "different-team", name: "Different", key: "DIF" }],
    })?.id).toBe(selected?.id);
    expect(parseProviderWorkspaceScope("linear", {
      id: "linear-workspace-scoped-user-id",
      name: "Zeeland",
      teams: [],
    })).toBeNull();
  });

  it("reads the workspace wrapper returned by Notion notion-fetch self", () => {
    expect(parseProviderWorkspaceScope("notion", {
      self: {
        workspace: {
          id: "notion-workspace-id",
          name: "Notion Workspace",
        },
      },
    })).toMatchObject({
      id: "notion-workspace-id",
      displayName: "Notion Workspace",
    });
  });
});
