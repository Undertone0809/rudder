import type { Db } from "@rudderhq/db";
import { describe, expect, it } from "vitest";
import type { StreamChatAssistantReplyInput } from "./chat-assistant.helpers.js";
import {
  chatContinuationTransportProfile,
  chatSessionForCurrentProviderProfile,
  deriveSideChatContextHandoff,
  deriveSideChatForkSourceForCurrentProfile,
  loadSideChatForkSource,
  resolveChatContinuationSession,
  sideChatForkSourceIdentityMatches,
} from "./chat-assistant.side-chat-source.js";

const validIdentity = {
  orgId: "organization-1",
  sourceConversationId: "source-chat-1",
  sourceRun: {
    id: "run-1",
    agentId: "agent-1",
    chatConversationId: "source-chat-1",
    sessionIdAfter: "opencode-session-1",
  },
  sourceSpan: {
    runId: "run-1",
    bindingId: "binding-1",
    selectorJson: { kind: "opencode_input", sessionId: "opencode-session-1" },
  },
  sourceSegment: {
    bindingId: "binding-1",
    runtimeType: "opencode_local",
    nativeSessionId: "opencode-session-1",
  },
  sourceBinding: {
    id: "binding-1",
    orgId: "organization-1",
    conversationId: "source-chat-1",
    agentId: "agent-1",
    runtimeType: "opencode_local",
    principalScopeRef: "org:organization-1",
    hostId: "local",
    profileId: "default",
  },
  sourceProviderProfile: { runtimeType: "opencode_local" },
};

function makeSideChatForkSourceDb(spans: Array<Record<string, unknown>>) {
  const results: unknown[][] = [
    [{ runId: "run-1" }],
    [{
      id: "run-1",
      agentId: "agent-1",
      chatConversationId: "source-chat-1",
      sessionIdAfter: "opencode-session-1",
      contextSnapshot: { runtimeProviderProfile: validIdentity.sourceProviderProfile },
    }],
    spans,
    [{
      nativeSessionId: "opencode-session-1",
      bindingId: "binding-1",
      runtimeType: "opencode_local",
      providerStateJson: { sessionId: "opencode-session-1" },
      leafId: null,
      sourceBoundaryRef: null,
    }],
    [validIdentity.sourceBinding],
  ];
  let nextResult = 0;
  const db = {
    select() {
      let rows: unknown[] = [];
      const query = {
        from(_source: unknown) {
          rows = results[nextResult++] ?? [];
          return query;
        },
        where(_condition: unknown) {
          return query;
        },
        orderBy(..._conditions: unknown[]) {
          return query;
        },
        limit(_count: number) {
          rows = rows.slice(0, _count);
          return query;
        },
        then(consume: (value: unknown[]) => unknown) {
          return Promise.resolve().then(() => consume(rows));
        },
      };
      return query;
    },
  };
  return { db: db as unknown as Db, queryCount: () => nextResult };
}

function sideChatForkSourceSpan(overrides: Record<string, unknown> = {}) {
  return {
    id: "span-1",
    runId: "run-1",
    nativeExecutionRef: "assistant-boundary-1",
    segmentId: "segment-1",
    bindingId: "binding-1",
    selectorJson: { kind: "opencode_input", sessionId: "opencode-session-1" },
    state: "sealed",
    completeness: "complete",
    ...overrides,
  };
}

describe("Side Chat visible context handoff", () => {
  const input = {
    conversation: {
      id: "child-chat", conversationKind: "side_chat",
      forkedFromConversationId: "parent-chat", forkedFromMessageId: "parent-reply",
    },
    userMessageId: "new-user",
    messages: [
      { id: "parent-user", role: "user", kind: "message", body: "First input" },
      { id: "parent-reply", role: "assistant", kind: "message", body: "First answer" },
      { id: "new-user", role: "user", kind: "message", body: "New input" },
    ],
  } as unknown as StreamChatAssistantReplyInput;

  it("retains visible source messages only for context handoff", () => {
    expect(deriveSideChatContextHandoff(input, null, "context_handoff")).toEqual({
      sourceConversationId: "parent-chat",
      sourceMessageId: "parent-reply",
      items: [
        { sourceId: "parent-user", role: "user", kind: "message", body: "First input" },
        { sourceId: "parent-reply", role: "assistant", kind: "message", body: "First answer" },
      ],
    });
    expect(deriveSideChatContextHandoff(input, null, "native")).toBeNull();
  });
});

describe("Side Chat fork source span mapping", () => {
  const conversation = {
    orgId: "organization-1",
    forkedFromConversationId: "source-chat-1",
    forkedFromMessageId: "source-message-1",
  };

  it("refuses native forking when the selected message's Run has continuation and subagent spans", async () => {
    const { db, queryCount } = makeSideChatForkSourceDb([
      sideChatForkSourceSpan({ id: "root-span", relation: "primary", ordinal: 0 }),
      sideChatForkSourceSpan({
        id: "continuation-span",
        relation: "continuation",
        ordinal: 1,
        nativeExecutionRef: "continuation-boundary",
      }),
      sideChatForkSourceSpan({
        id: "subagent-span",
        relation: "native_subagent",
        ordinal: 2,
        nativeExecutionRef: "subagent-boundary",
      }),
    ]);

    const source = await loadSideChatForkSource(db, conversation);

    expect(source).toMatchObject({
      sourceConversationId: "source-chat-1",
      sourceMessageId: "source-message-1",
      sourceRunId: null,
      sourceBoundaryRef: null,
      sourceSpanId: null,
      selectorJson: null,
      session: null,
    });
    expect(queryCount()).toBe(3);
  });

  it("retains native forking for the previous single-span Run shape", async () => {
    const { db } = makeSideChatForkSourceDb([sideChatForkSourceSpan()]);

    const source = await loadSideChatForkSource(db, conversation);

    expect(source).toMatchObject({
      sourceMessageId: "source-message-1",
      sourceRunId: "run-1",
      sourceBoundaryRef: "assistant-boundary-1",
      sourceSpanId: "span-1",
      selectorJson: { kind: "opencode_input", sessionId: "opencode-session-1" },
      session: {
        sessionId: "opencode-session-1",
        sessionParams: { sessionId: "opencode-session-1" },
      },
    });
  });
});

describe("Side Chat fork source identity", () => {
  it("requires the selected anchor Run, sealed span, binding, segment, and selector session to agree", () => {
    expect(sideChatForkSourceIdentityMatches(validIdentity)).toBe(true);
    expect(sideChatForkSourceIdentityMatches({
      ...validIdentity,
      sourceRun: { ...validIdentity.sourceRun, chatConversationId: "other-chat" },
    })).toBe(false);
    expect(sideChatForkSourceIdentityMatches({
      ...validIdentity,
      sourceSpan: {
        ...validIdentity.sourceSpan,
        selectorJson: { kind: "opencode_input", sessionId: "stopped-r1-session" },
      },
    })).toBe(false);
    expect(sideChatForkSourceIdentityMatches({
      ...validIdentity,
      sourceSegment: { ...validIdentity.sourceSegment, bindingId: "other-binding" },
    })).toBe(false);
  });

  it("rebuilds a forked OpenCode session transport from the current managed profile", () => {
    const source = {
      ...validIdentity,
      sourceRunId: "run-1",
      sourceMessageId: "message-1",
      sourceBoundaryRef: "message-boundary-1",
      sourceSpanId: "span-1",
      selectorJson: validIdentity.sourceSpan.selectorJson as never,
      sourceBinding: validIdentity.sourceBinding,
      sourceProviderProfile: {
        runtimeType: "opencode_local",
        serverUrl: "http://127.0.0.1:43123",
        exportEnv: {
          HOME: "/operator",
          XDG_DATA_HOME: "/old-managed/.local/share",
        },
      },
      session: {
        sessionId: "opencode-session-1",
        sessionDisplayId: "opencode-session-1",
        sessionParams: {
          sessionId: "opencode-session-1",
          hostId: "local",
          profileId: "default",
          profileBindingId: "binding-1",
          serverUrl: "http://127.0.0.1:43123",
          serverCommand: "old-opencode",
          exportCommand: "old-opencode",
          cwd: "/old-workspace",
          exportEnv: {
            HOME: "/operator",
            XDG_DATA_HOME: "/old-managed/.local/share",
            OPENCODE_CONFIG: "/old-managed/runtime-tmp/stopped-r1/opencode.json",
          },
        },
      },
    };

    const currentSource = deriveSideChatForkSourceForCurrentProfile(source, "opencode_local", {
      command: "opencode",
      serverCommand: "opencode",
      exportCommand: "opencode",
      cwd: "/current-workspace",
      providerVersion: "1.2.3",
      exportEnv: {
        HOME: "/operator",
        XDG_DATA_HOME: "/current-managed/.local/share",
      },
    });

    expect(currentSource.session).toMatchObject({
      sessionId: "opencode-session-1",
      sessionParams: {
        sessionId: "opencode-session-1",
        hostId: "local",
        profileId: "default",
        profileBindingId: "binding-1",
        serverUrl: "http://127.0.0.1:43123/",
        serverCommand: "opencode",
        exportCommand: "opencode",
        cwd: "/current-workspace",
        providerVersion: "1.2.3",
        transport: "opencode-managed-server-http",
        exportEnv: {
          HOME: "/operator",
          XDG_DATA_HOME: "/current-managed/.local/share",
        },
      },
    });
    expect(JSON.stringify(currentSource.session?.sessionParams)).not.toContain("stopped-r1");
    expect(currentSource.sourceProviderProfile?.exportEnv).not.toHaveProperty("OPENCODE_CONFIG");

    const continuation = chatContinuationTransportProfile(
      "opencode_local",
      {
        runtimeType: "opencode_local",
        serverUrl: "http://127.0.0.1:43123",
        exportEnv: {
          HOME: "/operator",
          XDG_DATA_HOME: "/old-managed/.local/share",
          OPENCODE_CONFIG: "/old-managed/runtime-tmp/stopped-r1/opencode.json",
        },
      },
      currentSource.session,
    );
    expect(continuation).toMatchObject({
      runtimeType: "opencode_local",
      serverUrl: "http://127.0.0.1:43123/",
      exportEnv: {
        HOME: "/operator",
        XDG_DATA_HOME: "/current-managed/.local/share",
      },
    });
    expect(JSON.stringify(continuation)).not.toContain("stopped-r1");
  });

  it("rebases resumed session transport and binding identity away from the stopped Run config", () => {
    const session = chatSessionForCurrentProviderProfile(
      "opencode_local",
      {
        sessionId: "opencode-session-1",
        sessionDisplayId: "opencode-session-1",
        sessionParams: {
          sessionId: "opencode-session-1",
          hostId: "local",
          profileId: "default",
          profileBindingId: "binding-r1",
          profileOrgId: "organization-1",
          capabilityRevision: "capability",
          serverUrl: "http://127.0.0.1:43123",
          serverCommand: "old-opencode",
          exportCommand: "old-opencode",
          cwd: "/old-workspace",
          workspaceId: "workspace-1",
          exportEnv: {
            HOME: "/operator",
            XDG_DATA_HOME: "/current-managed/.local/share",
            OPENCODE_CONFIG: "/current-managed/runtime-tmp/stopped-r1/opencode.json",
          },
        },
      },
      {
        command: "opencode",
        serverCommand: "opencode",
        exportCommand: "opencode",
        cwd: "/current-workspace",
        providerVersion: "1.2.3",
        serverUrl: "http://127.0.0.1:43124",
        exportEnv: {
          HOME: "/operator",
          XDG_DATA_HOME: "/current-managed/.local/share",
        },
      },
      {
        ...validIdentity.sourceBinding,
        id: "binding-r2",
        hostId: "local",
        profileId: "default",
        principalScopeRef: "org:organization-1",
        workspaceBindingId: "workspace-binding-2",
        capabilityRevision: "capability",
      },
    );

    expect(session.sessionParams).toMatchObject({
      sessionId: "opencode-session-1",
      hostId: "local",
      profileId: "default",
      profileBindingId: "binding-r2",
      profileOrgId: "organization-1",
      workspaceBindingId: "workspace-binding-2",
      capabilityRevision: "capability",
      serverUrl: "http://127.0.0.1:43124/",
      serverCommand: "opencode",
      exportCommand: "opencode",
      cwd: "/current-workspace",
      directory: "/current-workspace",
      workspaceId: "workspace-1",
      exportEnv: {
        HOME: "/operator",
        XDG_DATA_HOME: "/current-managed/.local/share",
      },
    });
    expect(JSON.stringify(session.sessionParams)).not.toContain("stopped-r1");
  });

  it("does not reuse a stopped OpenCode Run's export environment for the next continuation", async () => {
    const oldProfile = {
      runtimeType: "opencode_local",
      serverUrl: "http://127.0.0.1:43123",
      exportEnv: { XDG_DATA_HOME: "/stopped-r1", OPENCODE_CONFIG: "/stopped-r1/config.json" },
    };
    const query = {
      from: () => query,
      innerJoin: () => query,
      where: () => query,
      orderBy: () => query,
      limit: () => query,
      then: (consume: (rows: unknown[]) => unknown) => Promise.resolve(consume([
        { contextSnapshot: { runtimeProviderProfile: oldProfile } },
      ])),
    };
    const db = { select: () => query } as unknown as Db;
    const resolved = await resolveChatContinuationSession(db, {
      runtimeType: "opencode_local",
      config: {
        command: "opencode",
        serverUrl: "http://127.0.0.1:43124",
        exportEnv: { XDG_DATA_HOME: "/current-run" },
      },
      binding: { ...validIdentity.sourceBinding, id: "binding-r2" },
      segmentId: "segment-1",
      session: {
        sessionId: "opencode-session-1",
        sessionDisplayId: "opencode-session-1",
        sessionParams: {
          sessionId: "opencode-session-1",
          profileBindingId: "binding-r1",
          serverUrl: "http://127.0.0.1:43123",
          exportEnv: oldProfile.exportEnv,
        },
      },
      admittedSession: null,
    });

    expect(resolved.runtimeExecutionConfig).toMatchObject({
      serverUrl: "http://127.0.0.1:43124/",
      exportEnv: { XDG_DATA_HOME: "/current-run" },
    });
    expect(resolved.initialSession.sessionParams).toMatchObject({
      sessionId: "opencode-session-1",
      profileBindingId: "binding-r2",
      serverUrl: "http://127.0.0.1:43124/",
      exportEnv: { XDG_DATA_HOME: "/current-run" },
    });
    expect(JSON.stringify(resolved)).not.toContain("stopped-r1");
  });
});
