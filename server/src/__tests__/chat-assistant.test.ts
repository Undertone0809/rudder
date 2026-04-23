import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatConversation, ChatMessage } from "@rudder/shared";

const mockAdapter = vi.hoisted(() => ({
  execute: vi.fn(),
  parseStdoutLine: vi.fn((line: string, ts: string) => {
    const parsed = JSON.parse(line) as { type?: string; item?: Record<string, unknown> };
    const item = parsed.item ?? {};
    if (parsed.type === "item.completed" && item.type === "agent_message" && typeof item.text === "string") {
      return [{ kind: "assistant", ts, text: item.text }];
    }
    if (parsed.type === "item.completed" && item.type === "reasoning" && typeof item.text === "string") {
      return [{ kind: "thinking", ts, text: item.text }];
    }
    if (parsed.type === "item.started" && item.type === "tool_use") {
      return [{
        kind: "tool_call",
        ts,
        name: typeof item.name === "string" ? item.name : "tool",
        toolUseId: typeof item.id === "string" ? item.id : undefined,
        input: item.input ?? {},
      }];
    }
    if (parsed.type === "item.completed" && item.type === "tool_result") {
      return [{
        kind: "tool_result",
        ts,
        toolUseId: typeof item.tool_use_id === "string" ? item.tool_use_id : "tool_result",
        content: typeof item.content === "string" ? item.content : "",
        isError: item.status === "error",
      }];
    }
    if (parsed.type === "result") {
      return [{
        kind: "result",
        ts,
        text: typeof parsed.result === "string" ? parsed.result : "",
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        costUsd: 0,
        subtype: typeof parsed.subtype === "string" ? parsed.subtype : "result",
        isError: parsed.is_error === true,
        errors: [],
      }];
    }
    return [];
  }),
}));

const mockFindServerAdapter = vi.hoisted(() => vi.fn(() => mockAdapter));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockOrganizationService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockRunContextService = vi.hoisted(() => ({
  prepareRuntimeConfig: vi.fn(),
  ensureChatCopilotAgent: vi.fn(),
  resolveWorkspaceForRun: vi.fn(),
  buildSceneContext: vi.fn(),
}));

vi.mock("../agent-runtimes/index.js", () => ({
  findServerAdapter: mockFindServerAdapter,
}));

vi.mock("../services/agents.js", () => ({
  agentService: () => mockAgentService,
}));

vi.mock("../services/orgs.js", () => ({
  organizationService: () => mockOrganizationService,
}));

vi.mock("../services/agent-run-context.js", () => ({
  RUDDER_COPILOT_LABEL: "Rudder Copilot",
  agentRunContextService: () => mockRunContextService,
}));

const { chatAssistantService } = await import("../services/chat-assistant.js");

function makeConversation(overrides: Partial<ChatConversation> = {}): ChatConversation {
  const now = new Date("2026-03-29T08:00:00.000Z");
  return {
    id: "chat-1",
    orgId: "organization-1",
    status: "active",
    title: "Profile prompt test",
    summary: null,
    latestReplyPreview: null,
    preferredAgentId: null,
    routedAgentId: null,
    primaryIssueId: null,
    primaryIssue: null,
    issueCreationMode: "manual_approval",
    planMode: false,
    createdByUserId: "user-1",
    lastMessageAt: now,
    lastReadAt: now,
    isPinned: false,
    isUnread: false,
    unreadCount: 0,
    needsAttention: false,
    resolvedAt: null,
    chatRuntime: {
      sourceType: "copilot",
      sourceLabel: "Rudder Copilot",
      runtimeAgentId: "copilot-agent",
      agentRuntimeType: "codex_local",
      model: "gpt-5.4",
      available: true,
      error: null,
    },
    contextLinks: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeMessages(): ChatMessage[] {
  const now = new Date("2026-03-29T08:01:00.000Z");
  return [{
    id: "message-1",
    orgId: "organization-1",
    conversationId: "chat-1",
    role: "user",
    kind: "message",
    status: "completed",
    body: "Help me scope this work.",
    structuredPayload: null,
    approvalId: null,
    approval: null,
    attachments: [],
    replyingAgentId: null,
    chatTurnId: null,
    turnVariant: 0,
    supersededAt: null,
    createdAt: now,
    updatedAt: now,
  }];
}

describe("chatAssistantService operator profile prompt injection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOrganizationService.getById.mockResolvedValue({
      id: "organization-1",
      defaultChatAgentRuntimeType: "codex_local",
      defaultChatAgentRuntimeConfig: {
        model: "gpt-5.4",
      },
    });
    mockRunContextService.ensureChatCopilotAgent.mockResolvedValue({
      id: "copilot-agent",
      orgId: "organization-1",
      status: "idle",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: { model: "gpt-5.4" },
    });
    mockRunContextService.prepareRuntimeConfig.mockResolvedValue({
      resolvedConfig: { model: "gpt-5.4" },
      runtimeConfig: {
        model: "gpt-5.4",
        rudderSkillSync: { desiredSkills: ["org/build-advisor"] },
        paperclipSkillSync: { desiredSkills: ["org/build-advisor"] },
        rudderRuntimeSkills: [{ key: "org/build-advisor", name: "Build Advisor", runtimeName: "codex" }],
        paperclipRuntimeSkills: [{ key: "org/build-advisor", name: "Build Advisor", runtimeName: "codex" }],
      },
      runtimeSkillEntries: [{ key: "org/build-advisor", name: "Build Advisor", runtimeName: "codex" }],
      secretKeys: new Set(),
    });
    mockRunContextService.resolveWorkspaceForRun.mockResolvedValue({
      cwd: process.cwd(),
      source: "project_primary",
      projectId: null,
      workspaceId: null,
      repoUrl: null,
      repoRef: null,
      workspaceHints: [],
      warnings: [],
    });
    mockRunContextService.buildSceneContext.mockResolvedValue({
      rudderScene: "chat",
      rudderWorkspace: { cwd: process.cwd(), source: "project_primary" },
      rudderWorkspaces: [],
    });
    mockAdapter.execute.mockResolvedValue({
      summary: JSON.stringify({
        kind: "message",
        body: "Clarify the goal first.",
        structuredPayload: null,
      }),
      resultJson: null,
      timedOut: false,
      exitCode: 0,
      errorMessage: null,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("injects nickname and more-about-you into the Copilot chat prompt when present", async () => {
    const svc = chatAssistantService({} as any);

    await svc.generateChatAssistantReply({
      conversation: makeConversation(),
      messages: makeMessages(),
      contextLinks: [],
      operatorProfile: {
        nickname: "Zee",
        moreAboutYou: "Prefers concise, implementation-first responses.",
      },
    });

    const prompt = mockAdapter.execute.mock.calls[0]?.[0]?.context?.chatPrompt as string;
    expect(prompt).toContain("Always reply in the same language as the user's most recent substantive message unless they explicitly ask for a different language.");
    expect(prompt).toContain("You are Rudder Copilot");
    expect(prompt).toContain("Current board operator profile:");
    expect(prompt).toContain("- Preferred form of address: Zee");
    expect(prompt).toContain("- Background about the operator: Prefers concise, implementation-first responses.");
  });

  it("applies plan-mode prompt guidance and a read-only Codex runtime overlay", async () => {
    const svc = chatAssistantService({} as any);

    await svc.generateChatAssistantReply({
      conversation: makeConversation({ planMode: true }),
      messages: makeMessages(),
      contextLinks: [],
      operatorProfile: null,
    });

    const prompt = mockAdapter.execute.mock.calls.at(-1)?.[0]?.context?.chatPrompt as string;
    const runtimeConfig = mockAdapter.execute.mock.calls.at(-1)?.[0]?.config as Record<string, unknown>;
    expect(prompt).toContain("\"planMode\": true");
    expect(prompt).toContain("Plan mode is active for this conversation.");
    expect(prompt).toContain("Stay strictly in read-only investigation and planning mode.");
    expect(prompt).toContain("required markdown plan for the issue plan document");
    expect(runtimeConfig).toEqual(expect.objectContaining({
      dangerouslyBypassApprovalsAndSandbox: false,
      extraArgs: expect.arrayContaining(["-s", "read-only"]),
    }));
  });

  it("omits dormant plan-mode instructions from normal chat prompts", async () => {
    const svc = chatAssistantService({} as any);

    await svc.generateChatAssistantReply({
      conversation: makeConversation({ planMode: false }),
      messages: makeMessages(),
      contextLinks: [],
      operatorProfile: null,
    });

    const prompt = mockAdapter.execute.mock.calls.at(-1)?.[0]?.context?.chatPrompt as string;
    expect(prompt).not.toContain("Plan mode is active for this conversation.");
    expect(prompt).not.toContain("required markdown plan for the issue plan document");
    expect(prompt).toContain("\"body\": \"optional markdown plan\"");
  });

  it("omits the operator profile section when all profile fields are blank", async () => {
    const svc = chatAssistantService({} as any);

    await svc.generateChatAssistantReply({
      conversation: makeConversation(),
      messages: makeMessages(),
      contextLinks: [],
      operatorProfile: {
        nickname: "   ",
        moreAboutYou: "",
      },
    });

    const prompt = mockAdapter.execute.mock.calls[0]?.[0]?.context?.chatPrompt as string;
    expect(prompt).not.toContain("Current board operator profile:");
    expect(prompt).not.toContain("Preferred form of address");
    expect(prompt).not.toContain("Background about the operator");
  });

  it("prepends the shared org resources section to chat prompts when present", async () => {
    mockRunContextService.buildSceneContext.mockResolvedValueOnce({
      rudderScene: "chat",
      rudderWorkspace: {
        cwd: process.cwd(),
        source: "project_primary",
        orgResourcesPrompt: "## Organization Resources\n\n- Main codebase: ~/projects/rudder",
      },
      rudderWorkspaces: [],
    });

    const svc = chatAssistantService({} as any);

    await svc.generateChatAssistantReply({
      conversation: makeConversation(),
      messages: makeMessages(),
      contextLinks: [],
      operatorProfile: null,
    });

    const prompt = mockAdapter.execute.mock.calls.at(-1)?.[0]?.context?.chatPrompt as string;
    expect(prompt).toContain("## Organization Resources");
    expect(prompt).toContain("Main codebase: ~/projects/rudder");
  });

  it("forwards adapter invocation metadata to the caller during streaming", async () => {
    const svc = chatAssistantService({} as any);
    const invocationMeta: unknown[] = [];

    mockAdapter.execute.mockImplementationOnce(async (ctx) => {
      await ctx.onMeta?.({
        agentRuntimeType: "codex_local",
        command: "codex",
        cwd: "/tmp/chat-runtime",
        commandNotes: ["Loaded agent instructions from /tmp/agent-instructions.md"],
        prompt: String(ctx.context.chatPrompt),
        promptMetrics: {
          promptChars: String(ctx.context.chatPrompt).length,
        },
        context: ctx.context as Record<string, unknown>,
      });

      return {
        summary: JSON.stringify({
          kind: "message",
          body: "Clarify the goal first.",
          structuredPayload: null,
        }),
        resultJson: null,
        timedOut: false,
        exitCode: 0,
        errorMessage: null,
      };
    });

    await svc.streamChatAssistantReply({
      conversation: makeConversation(),
      messages: makeMessages(),
      contextLinks: [],
      onInvocationMeta: (meta) => {
        invocationMeta.push(meta);
      },
    });

    expect(invocationMeta).toEqual([
      expect.objectContaining({
        agentRuntimeType: "codex_local",
        command: "codex",
        cwd: "/tmp/chat-runtime",
        commandNotes: ["Loaded agent instructions from /tmp/agent-instructions.md"],
      }),
    ]);
    expect(invocationMeta[0]).toEqual(expect.objectContaining({
      prompt: expect.stringContaining("Conversation input:"),
    }));
  });

  it("uses the preferred agent as the chat speaker and preserves prepared runtime context", async () => {
    mockAgentService.getById.mockResolvedValueOnce({
      id: "agent-1",
      orgId: "organization-1",
      name: "Builder",
      status: "idle",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: { model: "gpt-5.4-builder", instructionsFilePath: "/tmp/builder/AGENTS.md" },
      metadata: null,
    });
    mockRunContextService.prepareRuntimeConfig.mockResolvedValueOnce({
      resolvedConfig: {
        model: "gpt-5.4-builder",
        instructionsFilePath: "/tmp/builder/AGENTS.md",
      },
      runtimeConfig: {
        model: "gpt-5.4-builder",
        instructionsFilePath: "/tmp/builder/AGENTS.md",
        rudderSkillSync: { desiredSkills: ["org/build-advisor"] },
        paperclipSkillSync: { desiredSkills: ["org/build-advisor"] },
        rudderRuntimeSkills: [{ key: "org/build-advisor", name: "Build Advisor", runtimeName: "codex" }],
        paperclipRuntimeSkills: [{ key: "org/build-advisor", name: "Build Advisor", runtimeName: "codex" }],
      },
      runtimeSkillEntries: [{ key: "org/build-advisor", name: "Build Advisor", runtimeName: "codex" }],
      secretKeys: new Set(),
    });
    mockRunContextService.resolveWorkspaceForRun.mockResolvedValueOnce({
      cwd: process.cwd(),
      source: "project_primary",
      projectId: null,
      workspaceId: null,
      repoUrl: null,
      repoRef: null,
      workspaceHints: [],
      warnings: [],
    });

    const svc = chatAssistantService({} as any);
    const result = await svc.generateChatAssistantReply({
      conversation: makeConversation({
        preferredAgentId: "agent-1",
        chatRuntime: {
          sourceType: "agent",
          sourceLabel: "Builder",
          runtimeAgentId: "agent-1",
          agentRuntimeType: "codex_local",
          model: "gpt-5.4-builder",
          available: true,
          error: null,
        },
      }),
      messages: makeMessages(),
      contextLinks: [],
    });

    const prompt = mockAdapter.execute.mock.calls.at(-1)?.[0]?.context?.chatPrompt as string;
    const runtimeConfig = mockAdapter.execute.mock.calls.at(-1)?.[0]?.config;
    expect(prompt).toContain("You are Builder, replying inside Rudder's chat scene.");
    expect(prompt).not.toContain("built-in chat assistant");
    expect(runtimeConfig).toEqual(expect.objectContaining({
      instructionsFilePath: "/tmp/builder/AGENTS.md",
      rudderSkillSync: { desiredSkills: ["org/build-advisor"] },
    }));
    expect(result.replyingAgentId).toBe("agent-1");
  });

  it("keeps Codex chat available when only an agent home workspace is available", async () => {
    mockRunContextService.resolveWorkspaceForRun.mockResolvedValueOnce({
      cwd: "/tmp/rudder-chat-agent-home",
      source: "agent_home",
      projectId: null,
      workspaceId: null,
      repoUrl: null,
      repoRef: null,
      workspaceHints: [],
      warnings: [],
    });

    const svc = chatAssistantService({} as any);
    const availability = await svc.getChatAssistantAvailability(makeConversation());

    expect(availability).toEqual(expect.objectContaining({
      available: true,
      error: null,
    }));
    expect(mockRunContextService.buildSceneContext).toHaveBeenCalledWith(expect.objectContaining({
      scene: "chat",
      resolvedWorkspace: expect.objectContaining({
        cwd: "/tmp/rudder-chat-agent-home",
        source: "agent_home",
      }),
    }));
  });

  it("streams visible assistant deltas while parsing the sentinel envelope", async () => {
    const svc = chatAssistantService({} as any);
    const deltas: string[] = [];
    const states: string[] = [];

    mockAdapter.execute.mockImplementationOnce(async (ctx) => {
      const prompt = String(ctx.context.chatPrompt);
      const sentinel = prompt.match(/(__RUDDER_RESULT_[a-f0-9-]+__)/i)?.[1] ?? "__RUDDER_RESULT_TEST__";
      const finalText =
        `Clarify the success criteria first.\n${sentinel}${JSON.stringify({
          kind: "message",
          body: "Clarify the success criteria first.",
          structuredPayload: null,
        })}`;

      await ctx.onLog(
        "stdout",
        `${JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "Clarify the success " },
        })}\n`,
      );
      await ctx.onLog(
        "stdout",
        `${JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: `criteria first.\n${sentinel}${JSON.stringify({
            kind: "message",
            body: "Clarify the success criteria first.",
            structuredPayload: null,
          })}` },
        })}\n`,
      );

      return {
        summary: finalText,
        resultJson: null,
        timedOut: false,
        exitCode: 0,
        errorMessage: null,
      };
    });

    const result = await svc.streamChatAssistantReply({
      conversation: makeConversation(),
      messages: makeMessages(),
      contextLinks: [],
      onAssistantDelta: (delta) => {
        deltas.push(delta);
      },
      onAssistantState: (state) => {
        states.push(state);
      },
    });

    expect(result).toEqual({
      outcome: "completed",
      partialBody: "Clarify the success criteria first.",
      replyingAgentId: "copilot-agent",
      reply: {
        kind: "message",
        body: "Clarify the success criteria first.",
        structuredPayload: null,
        replyingAgentId: "copilot-agent",
      },
    });
    expect(deltas.join("")).toContain("Clarify the success criteria first.");
    expect(deltas.join("")).not.toContain("__RUDDER_RESULT_");
    expect(states).toEqual(["streaming", "finalizing"]);
  });

  it("forwards non-assistant transcript entries while streaming", async () => {
    const svc = chatAssistantService({} as any);
    const entries: Array<{ kind: string; text?: string; name?: string; toolUseId?: string }> = [];

    mockAdapter.execute.mockImplementationOnce(async (ctx) => {
      await ctx.onLog(
        "stdout",
        `${JSON.stringify({
          type: "item.completed",
          item: { type: "reasoning", text: "Inspecting current chat state" },
        })}\n`,
      );
      await ctx.onLog(
        "stdout",
        `${JSON.stringify({
          type: "item.started",
          item: { type: "tool_use", id: "tool-1", name: "read_file", input: { path: "ui/src/pages/Chat.tsx" } },
        })}\n`,
      );
      await ctx.onLog(
        "stdout",
        `${JSON.stringify({
          type: "item.completed",
          item: { type: "tool_result", tool_use_id: "tool-1", content: "file loaded", status: "completed" },
        })}\n`,
      );
      await ctx.onLog(
        "stdout",
        `${JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "Done.\n" },
        })}\n`,
      );

      return {
        summary: JSON.stringify({
          kind: "message",
          body: "Done.",
          structuredPayload: null,
        }),
        resultJson: null,
        timedOut: false,
        exitCode: 0,
        errorMessage: null,
      };
    });

    await svc.streamChatAssistantReply({
      conversation: makeConversation(),
      messages: makeMessages(),
      contextLinks: [],
      onTranscriptEntry: (entry) => {
        entries.push(entry);
      },
    });

    expect(entries).toEqual([
      { kind: "thinking", text: "Inspecting current chat state" },
      { kind: "tool_call", name: "read_file", toolUseId: "tool-1" },
      { kind: "tool_result", toolUseId: "tool-1" },
    ].map((partial) => expect.objectContaining(partial)));
  });

  it("suppresses final result transcript events so the chat does not render duplicate replies", async () => {
    const svc = chatAssistantService({} as any);
    const entries: Array<{ kind: string; text?: string }> = [];
    const observedEntries: Array<{ kind: string; text?: string }> = [];

    mockAdapter.execute.mockImplementationOnce(async (ctx) => {
      const prompt = String(ctx.context.chatPrompt);
      const sentinel = prompt.match(/(__RUDDER_RESULT_[a-f0-9-]+__)/i)?.[1] ?? "__RUDDER_RESULT_TEST__";
      const finalText =
        `Hello Zeeland! I'm here to help clarify and route work requests. How can I assist you today?\n${sentinel}${JSON.stringify({
          kind: "message",
          body: "Hello Zeeland! I'm here to help clarify and route work requests. How can I assist you today?",
          structuredPayload: null,
        })}`;

      await ctx.onLog(
        "stdout",
        `${JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "Hello Zeeland! I'm here to help clarify and route work requests. How can I assist you today?" },
        })}\n`,
      );
      await ctx.onLog(
        "stdout",
        `${JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: finalText,
        })}\n`,
      );

      return {
        summary: finalText,
        resultJson: null,
        timedOut: false,
        exitCode: 0,
        errorMessage: null,
      };
    });

    const result = await svc.streamChatAssistantReply({
      conversation: makeConversation(),
      messages: makeMessages(),
      contextLinks: [],
      onTranscriptEntry: (entry) => {
        entries.push(entry);
      },
      onObservedTranscriptEntry: (entry) => {
        observedEntries.push(entry);
      },
    });

    expect(result).toEqual({
      outcome: "completed",
      partialBody: "Hello Zeeland! I'm here to help clarify and route work requests. How can I assist you today?",
      replyingAgentId: "copilot-agent",
      reply: {
        kind: "message",
        body: "Hello Zeeland! I'm here to help clarify and route work requests. How can I assist you today?",
        structuredPayload: null,
        replyingAgentId: "copilot-agent",
      },
    });
    expect(entries).toEqual([]);
    expect(observedEntries).toEqual([
      expect.objectContaining({
        kind: "assistant",
        text: "Hello Zeeland! I'm here to help clarify and route work requests. How can I assist you today?",
      }),
      expect.objectContaining({
        kind: "result",
        text: "Hello Zeeland! I'm here to help clarify and route work requests. How can I assist you today?",
      }),
    ]);
  });

  it("returns a stopped partial reply when the runtime abort signal fires", async () => {
    const svc = chatAssistantService({} as any);
    const controller = new AbortController();
    const states: string[] = [];

    mockAdapter.execute.mockImplementationOnce(async (ctx) => {
      await ctx.onLog(
        "stdout",
        `${JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "Partial streamed reply" },
        })}\n`,
      );
      controller.abort();
      return {
        summary: "Partial streamed reply",
        resultJson: null,
        timedOut: false,
        exitCode: null,
        signal: "SIGTERM",
        errorMessage: "aborted",
      };
    });

    const result = await svc.streamChatAssistantReply({
      conversation: makeConversation(),
      messages: makeMessages(),
      contextLinks: [],
      abortSignal: controller.signal,
      onAssistantState: (state) => {
        states.push(state);
      },
    });

    expect(result).toEqual({
      outcome: "stopped",
      partialBody: "Partial streamed reply",
      replyingAgentId: "copilot-agent",
    });
    expect(states).toEqual(["streaming", "stopped"]);
  });
});
