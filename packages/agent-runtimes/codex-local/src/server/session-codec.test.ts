import { describe, expect, it } from "vitest";
import { sessionCodec } from "./index.js";

describe("Codex native session codec", () => {
  it("round-trips App Server thread, root, fork, and profile metadata", () => {
    const raw = {
      sessionId: "thread-1",
      threadId: "thread-1",
      rootSessionId: "root-1",
      forkedFromId: "parent-1",
      model: "gpt-test",
      modelProvider: "openai",
      ephemeral: false,
      cwd: "/tmp/workspace",
      profileHostId: "local",
      profileId: "codex-profile",
      profileBindingId: "binding-1",
      profileOrgId: "org-1",
      workspaceBindingId: "workspace-1",
      capabilityRevision: "cap-1",
      secret: "must-not-persist",
    };

    const decoded = sessionCodec.deserialize(raw);
    expect(decoded).toEqual({
      sessionId: "thread-1",
      cwd: "/tmp/workspace",
      ...Object.fromEntries(Object.entries(raw).filter(([key]) => key !== "sessionId" && key !== "secret" && key !== "cwd")),
    });
    expect(sessionCodec.serialize(decoded)).toEqual(decoded);
    expect(sessionCodec.getDisplayId!(decoded)).toBe("thread-1");
  });

  it("accepts a persisted threadId as the canonical session identity without inventing one", () => {
    expect(sessionCodec.deserialize({ threadId: "thread-only", rootSessionId: "root-1" })).toEqual({
      sessionId: "thread-only",
      threadId: "thread-only",
      rootSessionId: "root-1",
    });
    expect(sessionCodec.deserialize({ rootSessionId: "root-without-thread" })).toBeNull();
  });
});
