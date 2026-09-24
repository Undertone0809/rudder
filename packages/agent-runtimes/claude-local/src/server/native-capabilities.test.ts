import { describe, expect, it } from "vitest";
import { sessionCodec } from "./index.js";
import {
  createClaudeLocalProviderCapabilities,
  createClaudeLocalProviderCapabilityResolver,
  parseClaudeSessionJsonl,
  resolveClaudeSessionFilePath,
  verifyClaudeSessionAssistantHead,
  type ClaudeLocalProfileTransport,
  type ClaudeNativeTranscriptReadRequest,
  type ClaudeProviderBindingRef,
} from "./native-capabilities.js";

const binding: ClaudeProviderBindingRef = {
  hostId: "host-claude-1",
  profileId: "profile-claude-1",
  capabilityRevision: "claude-jsonl-v1",
};
const cwd = "/tmp/claude-project";
const configDir = "/tmp/claude-config";
const sessionId = "claude-session-1";

const sessionJsonl = [
  {
    type: "user",
    uuid: "user-1",
    message: { role: "user", content: [{ type: "text", text: "Start here." }] },
  },
  {
    type: "assistant",
    uuid: "assistant-1",
    parentUuid: "user-1",
    message: { role: "assistant", content: [{ type: "text", text: "I will inspect it." }] },
  },
  {
    type: "user",
    uuid: "user-2",
    parentUuid: "assistant-1",
    message: { role: "user", content: [{ type: "tool_result", content: "done" }] },
  },
  {
    type: "assistant",
    uuid: "assistant-2",
    parentUuid: "user-2",
    message: { role: "assistant", content: [{ type: "text", text: "Finished." }] },
  },
  {
    type: "assistant",
    uuid: "unrelated-branch",
    parentUuid: "missing-parent",
    message: { role: "assistant", content: [{ type: "text", text: "Do not include me." }] },
  },
].map((entry) => JSON.stringify(entry)).join("\n");

function profile(readFile: ClaudeLocalProfileTransport["readFile"] = async () => sessionJsonl): ClaudeLocalProfileTransport {
  return { binding, cwd, configDir, providerVersion: "2.1.216", readFile };
}

function request(overrides: Partial<ClaudeNativeTranscriptReadRequest> = {}): ClaudeNativeTranscriptReadRequest {
  return {
    runtimeType: "claude_local",
    binding,
    session: {
      sessionId,
      sessionDisplayId: sessionId,
      sessionParams: {
        sessionId,
        cwd,
        claudeConfigDir: configDir,
        sessionFilePath: resolveClaudeSessionFilePath(configDir, cwd, sessionId),
        profileHostId: binding.hostId,
        profileId: binding.profileId,
        capabilityRevision: binding.capabilityRevision,
      },
    },
    ...overrides,
  };
}

describe("Claude profile-bound native capabilities", () => {
  it.each([
    { kind: "claude_chain", throughInclusiveUuid: null },
    { kind: "claude_chain", throughInclusiveUuid: "assistant-2", boundaryStatus: "missing" },
  ])("does not return the whole session for an unverified Run range", async (selector) => {
    const result = await createClaudeLocalProviderCapabilities(profile()).transcript.readRange(request({ selector }));
    expect(result.items).toEqual([]);
    expect(result.completeness).toBe("unknown");
    expect(result.availability).not.toBe("available");
  });

  it("reads the official JSONL session store through the parentUuid chain and selector boundary", async () => {
    const adapter = createClaudeLocalProviderCapabilities(profile());

    const result = await adapter.transcript.readRange(request({
      selector: {
        startExclusiveUuid: "user-1",
        throughInclusiveUuid: "assistant-2",
      },
    }));

    expect(result).toMatchObject({ source: "native", availability: "available", completeness: "complete" });
    expect(result.items.map((item) => item.sourceEntryId)).toEqual([
      "assistant-1:block:0",
      "user-2:block:0",
      "assistant-2:block:0",
    ]);
    expect(result.items.map((item) => item.text)).toEqual([
      "I will inspect it.",
      "done",
      "Finished.",
    ]);
    expect(result.items.some((item) => item.text === "Do not include me.")).toBe(false);
  });

  it("returns runtime-valid TranscriptEntry values for assistant thinking and tool blocks", async () => {
    const nativeSession = [
      {
        type: "assistant",
        uuid: "assistant-rich",
        message: {
          content: [
            { type: "text", text: "Visible answer." },
            { type: "thinking", thinking: "Internal reasoning." },
            { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "pwd" } },
          ],
        },
      },
      {
        type: "user",
        uuid: "tool-result",
        parentUuid: "assistant-rich",
        message: {
          content: [{ type: "tool_result", tool_use_id: "tool-1", content: " /tmp", is_error: false }],
        },
      },
    ].map((entry) => JSON.stringify(entry)).join("\n");
    const result = await createClaudeLocalProviderCapabilities(profile(async () => nativeSession)).transcript.readRange(request());

    expect(result.items).toHaveLength(4);
    expect(result.items.every((item) => (
      item.entry
      && typeof item.entry.kind === "string"
      && typeof item.entry.ts === "string"
      && typeof item.entry.sourceEntryId === "string"
    ))).toBe(true);
    expect(result.items.map((item) => item.entry.kind)).toEqual([
      "assistant",
      "thinking",
      "tool_call",
      "tool_result",
    ]);
    expect(result.items[0]?.entry).toMatchObject({ kind: "assistant", text: "Visible answer." });
    expect(result.items[1]?.entry).toMatchObject({ kind: "thinking", text: "Internal reasoning." });
    expect(result.items[2]?.entry).toMatchObject({ kind: "tool_call", name: "Bash", toolUseId: "tool-1", input: { command: "pwd" } });
    expect(result.items[3]?.entry).toMatchObject({ kind: "tool_result", toolUseId: "tool-1", content: " /tmp", isError: false });
  });

  it("applies from/through aliases and rejects a runtime mismatch", async () => {
    const adapter = createClaudeLocalProviderCapabilities(profile());

    const ranged = await adapter.transcript.readRange(request({
      range: {
        fromExclusive: "assistant-1:block:0",
        throughInclusive: "assistant-2:block:0",
      },
    }));
    const wrongRuntime = await adapter.transcript.readRange(request({ runtimeType: "cursor" }));

    expect(ranged.items.map((item) => item.sourceEntryId)).toEqual([
      "user-2:block:0",
      "assistant-2:block:0",
    ]);
    expect(wrongRuntime).toMatchObject({ availability: "incompatible", revision: "runtime-mismatch" });
  });

  it("classifies malformed or missing session sources and identity mismatches", async () => {
    const malformed = createClaudeLocalProviderCapabilities(profile(async () => `${sessionJsonl}\nnot-json`));
    const malformedResult = await malformed.transcript.readRange(request());
    expect(malformedResult).toMatchObject({ availability: "available", completeness: "partial" });

    const missing = createClaudeLocalProviderCapabilities(profile(async () => { throw new Error("ENOENT"); }));
    const missingResult = await missing.transcript.readRange(request());
    expect(missingResult.availability).toBe("missing");

    const wrongCwd = await malformed.transcript.readRange({
      ...request(),
      session: { ...request().session, sessionParams: { ...request().session.sessionParams, cwd: "/tmp/other-project" } },
    });
    expect(wrongCwd).toMatchObject({ availability: "incompatible", revision: "cwd-mismatch" });
  });

  it("does not claim an exact assistant-boundary fork for the session-level CLI fork", () => {
    const adapter = createClaudeLocalProviderCapabilities(profile());

    expect(adapter.fork.evidence.status).toBe("unsupported");
    expect(adapter.fork.evidence.reason).toContain("--fork-session");
    expect(adapter.fork.evidence.reason).toContain("completed assistant UUID");
    expect(adapter.fork.evidence.reason).toContain("without submitting a query");
    expect(adapter.control.steer.evidence).toMatchObject({
      status: "supported",
      transport: "claude-cli-stream-json",
      profileBound: true,
    });
    expect(adapter.control.steer.mode).toBe("native");
    expect(adapter.control.steer.requiresHandle).toBe(true);
    expect(adapter.control.interrupt.evidence).toMatchObject({
      status: "supported",
      transport: "claude-cli-stream-json",
      profileBound: true,
    });
    expect(adapter.control.interrupt.mode).toBe("process");
    expect(adapter.control.interrupt.requiresHandle).toBe(true);
  });

  it("matches the selected completed assistant head, not the session last UUID", async () => {
    const headSession = [
      {
        type: "user",
        uuid: "user-1",
        sessionId,
        message: { role: "user", content: "First prompt." },
      },
      {
        type: "assistant",
        uuid: "assistant-1",
        parentUuid: "user-1",
        sessionId,
        message: { role: "assistant", content: [{ type: "text", text: "First answer." }], stop_reason: "end_turn" },
      },
      {
        type: "result",
        uuid: "result-1",
        parentUuid: "assistant-1",
        sessionId,
      },
    ].map((entry) => JSON.stringify(entry)).join("\n");
    const sourceSession = {
      ...request().session,
      sessionParams: { ...request().session.sessionParams, lastUuid: "result-1" },
    };

    await expect(verifyClaudeSessionAssistantHead({
      profile: profile(async () => headSession),
      binding,
      session: sourceSession,
      sourceAssistantUuid: "assistant-1",
    })).resolves.toMatchObject({
      status: "matched",
      sourceAssistantUuid: "assistant-1",
      currentAssistantUuid: "assistant-1",
      reason: null,
    });
  });

  it.each([
    {
      label: "an appended user event",
      tail: [
        {
          type: "user",
          uuid: "user-in-flight",
          parentUuid: "assistant-1",
          sessionId,
          message: { role: "user", content: "A newer prompt is in flight." },
        },
      ],
    },
    {
      label: "an appended partial assistant event",
      tail: [
        {
          type: "user",
          uuid: "user-in-flight",
          parentUuid: "assistant-1",
          sessionId,
          message: { role: "user", content: "A newer prompt is in flight." },
        },
        {
          type: "assistant",
          uuid: "assistant-in-flight",
          parentUuid: "user-in-flight",
          sessionId,
          message: { role: "assistant", content: [{ type: "text", text: "A partial answer." }] },
        },
      ],
    },
    {
      label: "an appended user event without a UUID",
      tail: [
        {
          type: "user",
          parentUuid: "assistant-1",
          sessionId,
          message: { role: "user", content: "A newer prompt is in flight." },
        },
      ],
    },
  ])("fails closed when $label follows the selected assistant", async ({ tail }) => {
    const inFlightSession = [
      {
        type: "user",
        uuid: "user-1",
        sessionId,
        message: { role: "user", content: "First prompt." },
      },
      {
        type: "assistant",
        uuid: "assistant-1",
        parentUuid: "user-1",
        sessionId,
        message: { role: "assistant", content: [{ type: "text", text: "First answer." }], stop_reason: "end_turn" },
      },
      ...tail,
    ].map((entry) => JSON.stringify(entry)).join("\n");

    await expect(verifyClaudeSessionAssistantHead({
      profile: profile(async () => inFlightSession),
      binding,
      session: {
        ...request().session,
        sessionParams: { ...request().session.sessionParams, lastUuid: "result-1" },
      },
      sourceAssistantUuid: "assistant-1",
    })).resolves.toMatchObject({
      status: "unavailable",
      currentAssistantUuid: null,
    });
  });

  it("rejects a stale assistant boundary after a newer completed turn", async () => {
    const advancedSession = [
      {
        type: "user",
        uuid: "user-1",
        sessionId,
        message: { role: "user", content: "First prompt." },
      },
      {
        type: "assistant",
        uuid: "assistant-1",
        parentUuid: "user-1",
        sessionId,
        message: { role: "assistant", content: [{ type: "text", text: "First answer." }], stop_reason: "end_turn" },
      },
      {
        type: "user",
        uuid: "user-2",
        parentUuid: "assistant-1",
        sessionId,
        message: { role: "user", content: "Second prompt." },
      },
      {
        type: "assistant",
        uuid: "assistant-2",
        parentUuid: "user-2",
        sessionId,
        message: { role: "assistant", content: [{ type: "text", text: "Second answer." }], stop_reason: "end_turn" },
      },
      {
        type: "result",
        uuid: "result-2",
        parentUuid: "assistant-2",
        sessionId,
      },
    ].map((entry) => JSON.stringify(entry)).join("\n");

    await expect(verifyClaudeSessionAssistantHead({
      profile: profile(async () => advancedSession),
      binding,
      session: {
        ...request().session,
        sessionParams: { ...request().session.sessionParams, lastUuid: "result-2" },
      },
      sourceAssistantUuid: "assistant-1",
    })).resolves.toMatchObject({
      status: "mismatch",
      currentAssistantUuid: "assistant-2",
    });
  });

  it("fails closed when the current session chain is malformed or incomplete", async () => {
    const malformed = await verifyClaudeSessionAssistantHead({
      profile: profile(async () => `${sessionJsonl}\nnot-json`),
      binding,
      session: request().session,
      sourceAssistantUuid: "assistant-2",
    });
    const incompleteChain = await verifyClaudeSessionAssistantHead({
      profile: profile(async () => JSON.stringify({
        type: "assistant",
        uuid: "assistant-2",
        parentUuid: "missing-parent",
        sessionId,
        message: { role: "assistant", content: "answer", stop_reason: "end_turn" },
      })),
      binding,
      session: request().session,
      sourceAssistantUuid: "assistant-2",
    });

    expect(malformed).toMatchObject({ status: "unavailable", reason: expect.stringContaining("malformed") });
    expect(incompleteChain).toMatchObject({ status: "unavailable", reason: expect.stringContaining("incomplete") });
  });

  it("keeps optional binding identity attached to the profile-owned session store", async () => {
    const strictBinding: ClaudeProviderBindingRef = {
      ...binding,
      id: "binding-1",
      orgId: "org-1",
      workspaceBindingId: "workspace-1",
    };
    const strictProfile = { ...profile(), binding: strictBinding };
    const strictRequest = request({
      binding: strictBinding,
      session: {
        ...request().session,
        sessionParams: {
          ...request().session.sessionParams,
          profileBindingId: strictBinding.id,
          profileOrgId: strictBinding.orgId,
          workspaceBindingId: strictBinding.workspaceBindingId,
        },
      },
    });

    await expect(createClaudeLocalProviderCapabilities(strictProfile).transcript.readRange(strictRequest))
      .resolves.toMatchObject({ availability: "available" });
    await expect(createClaudeLocalProviderCapabilities(strictProfile).transcript.readRange({
      ...strictRequest,
      session: {
        ...strictRequest.session,
        sessionParams: { ...strictRequest.session.sessionParams, profileBindingId: "binding-2" },
      },
    })).resolves.toMatchObject({ availability: "incompatible", revision: "session-profile-mismatch" });
    await expect(createClaudeLocalProviderCapabilities({
      ...strictProfile,
      binding: { ...strictBinding, id: "binding-2" },
    }).transcript.readRange(strictRequest)).resolves.toMatchObject({
      availability: "incompatible",
      revision: "profile-mismatch",
    });
  });

  it("parses malformed JSONL without inventing records", () => {
    const parsed = parseClaudeSessionJsonl(`${JSON.stringify({ uuid: "valid" })}\nnot-json`);
    expect(parsed.records).toHaveLength(1);
    expect(parsed.malformed).toBe(true);
  });

  it("keeps session metadata profile-bound without persisting secrets", () => {
    const serialized = sessionCodec.serialize({
      sessionId,
      cwd,
      claudeConfigDir: configDir,
      sessionFilePath: resolveClaudeSessionFilePath(configDir, cwd, sessionId),
      profileHostId: binding.hostId,
      profileId: binding.profileId,
      capabilityRevision: binding.capabilityRevision,
      ANTHROPIC_API_KEY: "must-not-persist",
    });

    expect(serialized).toMatchObject({
      sessionId,
      claudeConfigDir: configDir,
      profileHostId: binding.hostId,
      profileId: binding.profileId,
    });
    expect(serialized).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(sessionCodec.deserialize(serialized)).toMatchObject({ sessionFilePath: expect.any(String) });
  });

  it("exposes a profile resolver while leaving the unbound declaration unknown", () => {
    const resolver = createClaudeLocalProviderCapabilityResolver(() => profile());

    expect(resolver("claude_local", binding)?.transcript.readRange).toBeTypeOf("function");
    expect(resolver("claude_local", null)?.transcript.evidence.status).toBe("unknown");
    expect(resolver("cursor", binding)).toBeNull();
  });
});
