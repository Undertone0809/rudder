import { describe, expect, it } from "vitest";
import { sessionCodec } from "./index.js";

describe("Claude native session codec", () => {
  it("round-trips profile-owned JSONL location and binding identity", () => {
    const raw = {
      sessionId: "claude-session-1",
      cwd: "/tmp/workspace",
      claudeConfigDir: "/tmp/claude-config",
      sessionFilePath: "/tmp/claude-config/projects/tmp-workspace/claude-session-1.jsonl",
      profileHostId: "local",
      profileId: "claude-profile",
      profileBindingId: "binding-1",
      profileOrgId: "org-1",
      workspaceBindingId: "workspace-1",
      capabilityRevision: "cap-1",
      lastUuid: "completed-assistant-1",
      secret: "must-not-persist",
    };

    const decoded = sessionCodec.deserialize(raw);
    expect(decoded).toEqual({
      sessionId: "claude-session-1",
      cwd: "/tmp/workspace",
      claudeConfigDir: "/tmp/claude-config",
      sessionFilePath: "/tmp/claude-config/projects/tmp-workspace/claude-session-1.jsonl",
      profileHostId: "local",
      profileId: "claude-profile",
      profileBindingId: "binding-1",
      profileOrgId: "org-1",
      workspaceBindingId: "workspace-1",
      capabilityRevision: "cap-1",
      lastUuid: "completed-assistant-1",
    });
    expect(sessionCodec.serialize(decoded)).toEqual(decoded);
  });
});
