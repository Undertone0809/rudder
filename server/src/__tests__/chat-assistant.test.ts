import type { ChatAttachment, ChatContextLink, ChatConversation, ChatMessage } from "@rudderhq/shared";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockAdapter = vi.hoisted(() => ({
  type: "codex_local",
  supportsLocalAgentJwt: true,
  execute: vi.fn(),
  parseStdoutLine: vi.fn((line: string, ts: string) => {
    const parsed = JSON.parse(line) as {
      type?: string;
      item?: Record<string, unknown>;
      errors?: unknown;
      result?: unknown;
      subtype?: unknown;
      is_error?: unknown;
    };
    const item = parsed.item ?? {};
    if (parsed.type === "item.completed" && item.type === "agent_message" && typeof item.text === "string") {
      const phase = item.phase === "commentary" || item.phase === "final_answer"
        ? item.phase
        : null;
      return [{
        kind: "assistant",
        ts,
        text: item.text,
        ...(item.delta === true ? { delta: true } : {}),
        ...(phase ? { phase } : {}),
      }];
    }
    if (parsed.type === "item.completed" && item.type === "reasoning" && typeof item.text === "string") {
      return [{
        kind: "thinking",
        ts,
        text: item.text,
        ...(item.delta === true ? { delta: true } : {}),
        ...(typeof item.extra === "string" ? { extra: item.extra } : {}),
      }];
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
    if (parsed.type === "item.completed" && item.type === "todo_list" && Array.isArray(item.items)) {
      return [{
        kind: "todo_list",
        ts,
        items: item.items as Array<{ text: string; status: "pending" | "in_progress" | "completed" }>,
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
        errors: Array.isArray(parsed.errors)
          ? parsed.errors.filter((value): value is string => typeof value === "string")
          : [],
      }];
    }
    return [];
  }),
}));

const mockFindServerAdapter = vi.hoisted(() => vi.fn(() => mockAdapter));

const mockAgentService = vi.hoisted(() => ({
  getInternalById: vi.fn(),
}));

const mockRunContextService = vi.hoisted(() => ({
  prepareRuntimeConfig: vi.fn(),
  materializeManagedInstructionsForRun: vi.fn(),
  resolveWorkspaceForRun: vi.fn(),
  buildSceneContext: vi.fn(),
}));

const mockChatAgentRuns = vi.hoisted(() => ({
  createRun: vi.fn(),
  appendAdapterInvoke: vi.fn(),
  appendTranscriptEntry: vi.fn(),
  finalizeRun: vi.fn(),
}));

vi.mock("../agent-runtimes/index.js", () => ({
  findServerAdapter: mockFindServerAdapter,
}));

vi.mock("../services/agents.js", () => ({
  agentService: () => mockAgentService,
}));

vi.mock("../services/agent-run-context.js", () => ({
  agentRunContextService: () => mockRunContextService,
}));

vi.mock("../services/chat-agent-runs.js", () => ({
  chatAgentRunService: () => mockChatAgentRuns,
}));

const { chatAssistantService } = await import("../services/chat-assistant.js");
const {
  ChatAssistantStreamError,
  validateAssistantResult,
} = await import("../services/chat-assistant.helpers.js");
const {
  userImageContentPathsFromMessages,
} = await import("../services/chat-assistant.proposal-validation.js");

let currentAgentHome = "";
const cleanupDirs = new Set<string>();

function makeManagedWorkspace(root = currentAgentHome) {
  return {
    agentHome: root,
    agentRoot: root,
    instructionsDir: path.join(root, "instructions"),
    memoryDir: path.join(root, "memory"),
    lifeDir: path.join(root, "life"),
    agentSkillsDir: path.join(root, "skills"),
  };
}

function makeSceneContext(rudderWorkspace: Record<string, unknown> = {}) {
  const managedWorkspace = makeManagedWorkspace();
  return {
    rudderScene: "chat",
    rudderWorkspace: {
      cwd: process.cwd(),
      source: "project_primary",
      ...managedWorkspace,
      ...rudderWorkspace,
    },
    rudderWorkspaces: [],
  };
}

function makeConversation(overrides: Partial<ChatConversation> = {}): ChatConversation {
  const now = new Date("2026-03-29T08:00:00.000Z");
  return {
    id: "chat-1",
    orgId: "organization-1",
    status: "active",
    title: "Profile prompt test",
    summary: null,
    latestReplyPreview: null,
    latestUserMessagePreview: null,
    userMessageCount: 0,
    preferredAgentId: "agent-1",
    modelOverride: null,
    effortOverride: null,
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
      sourceType: "agent",
      sourceLabel: "Chat Specialist",
      runtimeAgentId: "agent-1",
      agentRuntimeType: "codex_local",
      model: "gpt-5.4",
      effort: null,
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

function makeAttachment(overrides: Partial<ChatAttachment> = {}): ChatAttachment {
  const now = new Date("2026-03-29T08:01:00.000Z");
  const id = overrides.id ?? "attachment-1";
  const assetId = overrides.assetId ?? "asset-1";
  return {
    id,
    orgId: "organization-1",
    conversationId: "chat-1",
    messageId: "message-1",
    assetId,
    provider: "local_disk",
    objectKey: `chats/chat-1/${id}`,
    contentType: "image/png",
    byteSize: 1234,
    sha256: "sha256",
    originalFilename: `${id}.png`,
    createdByAgentId: null,
    createdByUserId: "user-1",
    contentPath: `/api/assets/${assetId}/content`,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeStorageService(body = Buffer.from("image-bytes")) {
  return {
    provider: "local_disk",
    getObject: vi.fn(async () => ({
      stream: Readable.from(body),
      contentType: "image/png",
      contentLength: body.length,
    })),
    putFile: vi.fn(),
    headObject: vi.fn(),
    deleteObject: vi.fn(),
  };
}

function makeProjectContextLink(): ChatContextLink {
  const now = new Date("2026-03-29T08:00:00.000Z");
  return {
    id: "context-project-1",
    orgId: "organization-1",
    conversationId: "chat-1",
    entityType: "project",
    entityId: "project-1",
    metadata: null,
    entity: {
      type: "project",
      id: "project-1",
      label: "Launch Ops",
      subtitle: "Coordinate the launch workflow.",
      identifier: null,
      status: "in_progress",
      href: "/projects/project-1",
    },
    createdAt: now,
    updatedAt: now,
  };
}

function makeIssueContextLink(): ChatContextLink {
  const now = new Date("2026-03-29T08:00:00.000Z");
  return {
    id: "context-issue-1",
    orgId: "organization-1",
    conversationId: "chat-1",
    entityType: "issue",
    entityId: "issue-1",
    metadata: null,
    entity: {
      type: "issue",
      id: "issue-1",
      label: "Fix issue chat handoff",
      subtitle: "in_progress",
      identifier: "ISS-42",
      status: "in_progress",
      description: "Clicking Chat from an issue should open a contextual new chat composer.",
      priority: "medium",
      href: "/issues/ISS-42",
    },
    createdAt: now,
    updatedAt: now,
  };
}

function sentinelFromContext(ctx: { context?: Record<string, unknown> }) {
  const prompt = String(ctx.context?.chatPrompt ?? "");
  return prompt.match(/(__RUDDER_RESULT_[a-f0-9-]+__)/i)?.[1] ?? "__RUDDER_RESULT_TEST__";
}

function assistantSummary(ctx: { context?: Record<string, unknown> }, body: string) {
  return `${sentinelFromContext(ctx)}${JSON.stringify({
    kind: "message",
    body,
    structuredPayload: null,
  })}`;
}

function askUserSummary(ctx: { context?: Record<string, unknown> }) {
  return `${sentinelFromContext(ctx)}${JSON.stringify({
    kind: "ask_user",
    body: "I need one decision before continuing.",
    structuredPayload: {
      requestUserInput: {
        questions: [
          {
            id: "scope",
            header: "Scope",
            question: "Which scope should I use?",
            options: [
              { id: "narrow", label: "Narrow", description: "Smallest shippable path", recommended: true },
              { id: "broad", label: "Broad" },
            ],
            allowFreeform: true,
          },
        ],
      },
    },
  })}`;
}

function makeAutomationRunInputMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    ...makeMessages()[0]!,
    id: "automation-run-input-message",
    body: "Send me a daily information flow.\n\nAutomation: Daily information flow\nTrigger source: schedule",
    structuredPayload: {
      eventType: "automation_run_input",
      automationChatRun: {
        automationId: "automation-1",
        automationTitle: "Daily information flow",
        runId: "run-1",
        source: "schedule",
        status: "running",
      },
      guidance: {
        intent: "execute_existing_automation",
        mayCreateAutomation: false,
      },
    },
    ...overrides,
  };
}

describe("chatAssistantService operator profile prompt injection", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    currentAgentHome = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-chat-agent-home-"));
    cleanupDirs.add(currentAgentHome);
    mockFindServerAdapter.mockImplementation(() => mockAdapter);
    mockAgentService.getInternalById.mockResolvedValue({
      id: "agent-1",
      orgId: "organization-1",
      name: "Chat Specialist",
      status: "idle",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: { model: "gpt-5.4" },
      metadata: null,
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
    mockRunContextService.materializeManagedInstructionsForRun.mockImplementation(async (agent) =>
      (agent.agentRuntimeConfig ?? {}) as Record<string, unknown>,
    );
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
    mockRunContextService.buildSceneContext.mockResolvedValue(makeSceneContext());
    mockChatAgentRuns.createRun.mockResolvedValue({
      id: "chat-run-1",
      orgId: "organization-1",
      agentId: "agent-1",
      status: "running",
    });
    mockChatAgentRuns.appendAdapterInvoke.mockResolvedValue(undefined);
    mockChatAgentRuns.appendTranscriptEntry.mockResolvedValue(undefined);
    mockChatAgentRuns.finalizeRun.mockResolvedValue(undefined);
    mockAdapter.execute.mockImplementation(async (ctx) => ({
      summary: assistantSummary(ctx, "Clarify the goal first."),
      resultJson: null,
      timedOut: false,
      exitCode: 0,
      errorMessage: null,
    }));
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await Promise.all(Array.from(cleanupDirs).map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
      cleanupDirs.delete(dir);
    }));
  });

  it("reports chat as unavailable until a preferred agent is selected", async () => {
    const svc = chatAssistantService({} as any);

    const availability = await svc.getChatAssistantAvailability(makeConversation({
      preferredAgentId: null,
      chatRuntime: {
        sourceType: "unconfigured",
        sourceLabel: "Choose an agent",
        runtimeAgentId: null,
        agentRuntimeType: null,
        model: null,
        available: false,
        error: "Choose a chat agent before sending messages.",
      },
    }));

    expect(availability).toEqual({
      sourceType: "unconfigured",
      sourceLabel: "Choose an agent",
      runtimeAgentId: null,
      agentRuntimeType: null,
      model: null,
      available: false,
      error: "Choose a chat agent before sending messages.",
    });
    expect(mockAgentService.getInternalById).not.toHaveBeenCalled();
  });

  it("deduplicates list runtime enrichment by organization and preferred agent", async () => {
    const svc = chatAssistantService({} as any);
    const conversations = [
      makeConversation({
        id: "chat-list-1",
        chatRuntime: {
          ...makeConversation().chatRuntime,
          sourceLabel: "Original descriptor 1",
        },
      }),
      makeConversation({
        id: "chat-list-2",
        chatRuntime: {
          ...makeConversation().chatRuntime,
          sourceLabel: "Original descriptor 2",
        },
      }),
    ];
    const inputSnapshots = conversations.map((conversation) => ({ ...conversation }));
    const inputDescriptors = conversations.map((conversation) => conversation.chatRuntime);

    const enriched = await svc.enrichConversations(conversations);
    const expectedChatRuntime = {
      sourceType: "agent",
      sourceLabel: "Chat Specialist",
      runtimeAgentId: "agent-1",
      agentRuntimeType: "codex_local",
      model: "gpt-5.4",
      effort: null,
      available: true,
      error: null,
    };

    expect(mockAgentService.getInternalById).toHaveBeenCalledTimes(1);
    expect(mockRunContextService.prepareRuntimeConfig).toHaveBeenCalledTimes(1);
    expect(mockRunContextService.prepareRuntimeConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        scene: "chat",
        materializeMissingRuntimeSkills: false,
      }),
    );
    expect(enriched.map((conversation) => conversation.id)).toEqual(["chat-list-1", "chat-list-2"]);
    enriched.forEach((conversation, index) => {
      expect(conversation).not.toBe(conversations[index]);
      expect(conversation).toEqual({
        ...conversations[index],
        chatRuntime: expectedChatRuntime,
      });
    });
    expect(conversations).toEqual(inputSnapshots);
    conversations.forEach((conversation, index) => {
      expect(conversation.chatRuntime).toBe(inputDescriptors[index]);
    });

    mockAgentService.getInternalById.mockReset();
    mockRunContextService.prepareRuntimeConfig.mockClear();
    mockAgentService.getInternalById
      .mockResolvedValueOnce({
        id: "agent-1",
        orgId: "organization-1",
        name: "Chat Specialist",
        status: "idle",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: { model: "gpt-5.4" },
        metadata: null,
      })
      .mockResolvedValueOnce({
        id: "agent-1",
        orgId: "organization-2",
        name: "Chat Specialist",
        status: "idle",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: { model: "gpt-5.4" },
        metadata: null,
      });

    const crossOrganization = await svc.enrichConversations([
      makeConversation({ id: "chat-org-1", orgId: "organization-1" }),
      makeConversation({ id: "chat-org-2", orgId: "organization-2" }),
    ]);

    expect(mockAgentService.getInternalById).toHaveBeenCalledTimes(2);
    expect(mockRunContextService.prepareRuntimeConfig).toHaveBeenCalledTimes(2);
    expect(crossOrganization.map((conversation) => conversation.id)).toEqual([
      "chat-org-1",
      "chat-org-2",
    ]);
    expect(crossOrganization.map((conversation) => conversation.chatRuntime)).toEqual([
      expectedChatRuntime,
      expectedChatRuntime,
    ]);
  });

  it("keeps process chat agents available through the shared Chat contract", async () => {
    const svc = chatAssistantService({} as any);
    mockAgentService.getInternalById.mockResolvedValueOnce({
      id: "agent-1",
      orgId: "organization-1",
      name: "Navigator",
      status: "idle",
      agentRuntimeType: "process",
      agentRuntimeConfig: { command: process.execPath },
      metadata: null,
    });
    mockRunContextService.prepareRuntimeConfig.mockResolvedValueOnce({
      resolvedConfig: { command: process.execPath },
      runtimeConfig: { command: process.execPath },
      runtimeSkillEntries: [],
      secretKeys: new Set(),
    });

    const availability = await svc.getChatAssistantAvailability(makeConversation({
      chatRuntime: {
        sourceType: "agent",
        sourceLabel: "Navigator",
        runtimeAgentId: "agent-1",
        agentRuntimeType: "process",
        model: "Default model",
        available: true,
        error: null,
      },
    }));

    expect(availability).toEqual({
      sourceType: "agent",
      sourceLabel: "Navigator",
      runtimeAgentId: "agent-1",
      agentRuntimeType: "process",
      model: "Default model",
      effort: null,
      available: true,
      error: null,
    });
    expect(mockAdapter.execute).not.toHaveBeenCalled();
  });

  it("does not advertise Chat for an unregistered adapter type", async () => {
    const svc = chatAssistantService({} as any);
    mockFindServerAdapter.mockReturnValueOnce(undefined);

    const availability = await svc.getChatAssistantAvailability(makeConversation());

    expect(availability).toMatchObject({
      available: false,
      error: "The selected agent runtime is not registered with Rudder Chat.",
    });
  });

  it("refuses to generate a reply without a preferred agent", async () => {
    const svc = chatAssistantService({} as any);

    const error = await svc.generateChatAssistantReply({
      conversation: makeConversation({
        preferredAgentId: null,
        chatRuntime: {
          sourceType: "unconfigured",
          sourceLabel: "Choose an agent",
          runtimeAgentId: null,
          agentRuntimeType: null,
          model: null,
          available: false,
          error: "Choose a chat agent before sending messages.",
        },
      }),
      messages: makeMessages(),
      contextLinks: [],
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(ChatAssistantStreamError);
    expect(error).toMatchObject({
      message: "Choose a chat agent before sending messages.",
      userMessage: "Choose a chat agent before sending messages.",
      errorCode: "chat_runtime_boot_failed",
      failurePhase: "runtime_boot",
      action: "repair_runtime",
      retryable: false,
    });
    expect(mockAgentService.getInternalById).not.toHaveBeenCalled();
    expect(mockAdapter.execute).not.toHaveBeenCalled();
  });

  it("injects nickname and more-about-you into the selected agent chat prompt when present", async () => {
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
    expect(prompt).toContain("You are Chat Specialist, replying inside Rudder's chat scene.");
    expect(prompt).toContain("Before answering, classify the user's request depth:");
    expect(prompt).toContain("Product, design, architecture, strategy, or workflow judgment: reason from scenarios, actors, needs, non-needs, constraints, failure modes, and corner cases before giving a decision-ready answer.");
    expect(prompt).toContain("Do not claim certainty you do not have. State assumptions, confidence, and remaining unknowns when they matter.");
    expect(prompt).toContain("Current board operator profile:");
    expect(prompt).toContain("- Preferred form of address: Zee");
    expect(prompt).toContain("- Background about the operator: Prefers concise, implementation-first responses.");
    expect(prompt).toContain("Resolved Rudder built-in skill projection: visualize (Chat v1).");
    expect(prompt).toContain(":::rudder-inline-visual:v1");
    expect(prompt).toContain(":::rudder-inline-visual:end");
    expect(prompt).toContain('<div id="widget">');
    expect(prompt).toContain("Do not emit an iframe, file path, attachment id, or provider-specific directive");
    expect(prompt).not.toContain("::codex-inline-vis");
    expect(mockAdapter.execute.mock.calls[0]?.[0]?.context).toMatchObject({
      rudderChatInlineVisualProtocolVersion: 1,
    });
  });

  it("includes chat attachments in the runtime prompt as prepared local image paths without auth-bearing download commands", async () => {
    const storage = makeStorageService();
    const svc = chatAssistantService({} as any, storage as any);
    const [message] = makeMessages();
    const messageWithAttachment: ChatMessage = {
      ...message!,
      attachments: [{
        id: "attachment-1",
        orgId: "organization-1",
        conversationId: "chat-1",
        messageId: "message-1",
        assetId: "asset-1",
        provider: "local_disk",
        objectKey: "chats/chat-1/image.png",
        contentType: "image/png",
        byteSize: 1234,
        sha256: "sha256",
        originalFilename: "image.png",
        createdByAgentId: null,
        createdByUserId: "user-1",
        contentPath: "/api/assets/asset-1/content",
        createdAt: new Date("2026-03-29T08:01:00.000Z"),
        updatedAt: new Date("2026-03-29T08:01:00.000Z"),
      }],
    };

    await svc.generateChatAssistantReply({
      conversation: makeConversation(),
      messages: [messageWithAttachment],
      contextLinks: [],
      operatorProfile: null,
    });

    const executeInput = mockAdapter.execute.mock.calls.at(-1)?.[0];
    const prompt = executeInput?.context?.chatPrompt as string;
    expect(prompt).toContain("Treat message attachments as part of the user's message.");
    expect(prompt).toContain("Current user message attachments:");
    expect(prompt).toContain("The latest user message includes 1 attachment(s). Inspect any listed localPath directly before answering.");
    expect(prompt).toContain("contentPath is the canonical user-visible Rudder asset path.");
    expect(prompt).toContain("use that exact contentPath as the Markdown image target");
    expect(prompt).toContain("localPath is temporary runtime-only inspection context.");
    expect(prompt).toContain("this metadata does not require copying every attachment into a proposal");
    expect(prompt).toContain('User message body: "Help me scope this work."');
    expect(prompt).toContain("- [1] name=image.png; contentType=image/png; byteSize=1234; contentPath=/api/assets/asset-1/content;");
    expect(prompt).toMatch(/localPath=.*image\.png/);
    expect(prompt).toContain("runtimeReference=local_image_file");
    expect(prompt).toContain("\"attachments\": [");
    expect(prompt).toContain("\"name\": \"image.png\"");
    expect(prompt).toContain("\"contentType\": \"image/png\"");
    expect(prompt).toMatch(/"localPath": ".*image\.png"/);
    expect(prompt).not.toContain("\"fetchUrl\"");
    expect(prompt).not.toContain("downloadCommand");
    expect(prompt).not.toContain("Authorization: Bearer $RUDDER_API_KEY");
    expect(executeInput?.context?.chatAttachments).toEqual([
      expect.objectContaining({
        attachmentId: "attachment-1",
        localPath: expect.stringMatching(/image\.png$/),
      }),
    ]);
    expect(executeInput?.media).toEqual([
      expect.objectContaining({
        source: "chat_attachment",
        attachmentId: "attachment-1",
        assetId: "asset-1",
        contentType: "image/png",
        localPath: expect.stringMatching(/image\.png$/),
      }),
    ]);
    expect(storage.getObject).toHaveBeenCalledWith("organization-1", "chats/chat-1/image.png");
    expect(executeInput?.authToken).toEqual(expect.any(String));
  });

  it("prepares multiple chat images in message order and does not pass non-images as runtime media", async () => {
    const storage = makeStorageService();
    const svc = chatAssistantService({} as any, storage as any);
    const [message] = makeMessages();
    const messageWithAttachments: ChatMessage = {
      ...message!,
      attachments: [
        makeAttachment({
          id: "attachment-image-1",
          assetId: "asset-image-1",
          objectKey: "chats/chat-1/first.png",
          originalFilename: "first.png",
          contentType: "image/png",
          contentPath: "/api/assets/asset-image-1/content",
        }),
        makeAttachment({
          id: "attachment-text-1",
          assetId: "asset-text-1",
          objectKey: "chats/chat-1/notes.txt",
          originalFilename: "notes.txt",
          contentType: "text/plain",
          contentPath: "/api/assets/asset-text-1/content",
        }),
        makeAttachment({
          id: "attachment-image-2",
          assetId: "asset-image-2",
          objectKey: "chats/chat-1/second.png",
          originalFilename: "second.png",
          contentType: "image/png",
          contentPath: "/api/assets/asset-image-2/content",
        }),
      ],
    };

    await svc.generateChatAssistantReply({
      conversation: makeConversation(),
      messages: [messageWithAttachments],
      contextLinks: [],
      operatorProfile: null,
    });

    const executeInput = mockAdapter.execute.mock.calls.at(-1)?.[0];
    expect(executeInput?.media?.map((item) => item.attachmentId)).toEqual([
      "attachment-image-1",
      "attachment-image-2",
    ]);
    expect(executeInput?.context?.chatAttachments).toEqual([
      expect.objectContaining({ attachmentId: "attachment-image-1", localPath: expect.stringMatching(/first\.png$/) }),
      expect.objectContaining({ attachmentId: "attachment-image-2", localPath: expect.stringMatching(/second\.png$/) }),
    ]);
    expect(storage.getObject).toHaveBeenCalledTimes(2);
    expect(storage.getObject).toHaveBeenNthCalledWith(1, "organization-1", "chats/chat-1/first.png");
    expect(storage.getObject).toHaveBeenNthCalledWith(2, "organization-1", "chats/chat-1/second.png");
    const prompt = executeInput?.context?.chatPrompt as string;
    expect(prompt).toContain("name=notes.txt; contentType=text/plain");
    expect(prompt).not.toMatch(/notes\.txt;.*runtimeReference=local_image_file/);
  });

  it("records image attachment materialization failures without passing broken media to the runtime", async () => {
    const storage = makeStorageService();
    storage.getObject.mockRejectedValueOnce(new Error("storage unavailable"));
    const svc = chatAssistantService({} as any, storage as any);
    const [message] = makeMessages();
    const messageWithAttachment: ChatMessage = {
      ...message!,
      attachments: [makeAttachment({
        id: "attachment-broken",
        assetId: "asset-broken",
        objectKey: "chats/chat-1/broken.png",
        originalFilename: "broken.png",
        contentPath: "/api/assets/asset-broken/content",
      })],
    };

    await svc.generateChatAssistantReply({
      conversation: makeConversation(),
      messages: [messageWithAttachment],
      contextLinks: [],
      operatorProfile: null,
    });

    const executeInput = mockAdapter.execute.mock.calls.at(-1)?.[0];
    expect(executeInput?.media).toBeUndefined();
    expect(executeInput?.context?.chatAttachments).toEqual([
      expect.objectContaining({
        attachmentId: "attachment-broken",
        localPathError: "storage unavailable",
      }),
    ]);
    const prompt = executeInput?.context?.chatPrompt as string;
    expect(prompt).toContain("localPathError=storage unavailable");
    expect(prompt).not.toContain("runtimeReference=local_image_file");
  });

  it("prepares chat image attachments for Claude chat agents too", async () => {
    const storage = makeStorageService();
    const svc = chatAssistantService({} as any, storage as any);
    mockAgentService.getInternalById.mockResolvedValueOnce({
      id: "agent-1",
      orgId: "organization-1",
      name: "Claude Specialist",
      status: "idle",
      agentRuntimeType: "claude_local",
      agentRuntimeConfig: { model: "claude-sonnet-4.5" },
      metadata: null,
    });
    mockRunContextService.prepareRuntimeConfig.mockResolvedValueOnce({
      resolvedConfig: { model: "claude-sonnet-4.5" },
      runtimeConfig: {
        model: "claude-sonnet-4.5",
        rudderSkillSync: { desiredSkills: [] },
        paperclipSkillSync: { desiredSkills: [] },
        rudderRuntimeSkills: [],
        paperclipRuntimeSkills: [],
      },
      runtimeSkillEntries: [],
      secretKeys: new Set(),
    });
    const [message] = makeMessages();
    const messageWithAttachment: ChatMessage = {
      ...message!,
      attachments: [{
        id: "attachment-claude-1",
        orgId: "organization-1",
        conversationId: "chat-1",
        messageId: "message-1",
        assetId: "asset-claude-1",
        provider: "local_disk",
        objectKey: "chats/chat-1/claude-image.png",
        contentType: "image/png",
        byteSize: 1234,
        sha256: "sha256",
        originalFilename: "claude-image.png",
        createdByAgentId: null,
        createdByUserId: "user-1",
        contentPath: "/api/assets/asset-claude-1/content",
        createdAt: new Date("2026-03-29T08:01:00.000Z"),
        updatedAt: new Date("2026-03-29T08:01:00.000Z"),
      }],
    };

    await svc.generateChatAssistantReply({
      conversation: makeConversation(),
      messages: [messageWithAttachment],
      contextLinks: [],
      operatorProfile: null,
    });

    const executeInput = mockAdapter.execute.mock.calls.at(-1)?.[0];
    const prompt = executeInput?.context?.chatPrompt as string;
    expect(prompt).toContain("localPath=");
    expect(prompt).toContain("runtimeReference=local_image_file");
    expect(executeInput?.media).toEqual([
      expect.objectContaining({
        source: "chat_attachment",
        attachmentId: "attachment-claude-1",
        assetId: "asset-claude-1",
        contentType: "image/png",
        localPath: expect.stringMatching(/claude-image\.png$/),
      }),
    ]);
    expect(storage.getObject).toHaveBeenCalledWith("organization-1", "chats/chat-1/claude-image.png");
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
    expect(prompt).toContain("Put the implementation plan in the issue proposal description or cite a Project Library file link");
    expect(runtimeConfig).toEqual(expect.objectContaining({
      dangerouslyBypassApprovalsAndSandbox: false,
      extraArgs: expect.arrayContaining(["-s", "read-only"]),
    }));
  });

  it("applies a conversation model override without mutating fallback or workspace config", async () => {
    const modelFallbacks = [{
      agentRuntimeType: "codex_local",
      model: "gpt-5.4-mini",
    }];
    mockRunContextService.prepareRuntimeConfig.mockResolvedValueOnce({
      resolvedConfig: {},
      runtimeConfig: {
        model: "gpt-5.4",
        modelReasoningEffort: "ultra",
        modelFallbacks,
        cwd: "/tmp/chat-workspace",
        rudderSkillSync: { desiredSkills: ["org/build-advisor"] },
      },
      runtimeSkillEntries: [],
      secretKeys: new Set(["OPENAI_API_KEY"]),
    });
    const svc = chatAssistantService({} as any);

    await svc.generateChatAssistantReply({
      conversation: makeConversation({ modelOverride: "gpt-5.6-terra" }),
      messages: makeMessages(),
      contextLinks: [],
    });

    const runtimeConfig = mockAdapter.execute.mock.calls.at(-1)?.[0]?.config as Record<string, unknown>;
    expect(runtimeConfig).toEqual(expect.objectContaining({
      model: "gpt-5.6-terra",
      modelReasoningEffort: "ultra",
      modelFallbacks,
      cwd: "/tmp/chat-workspace",
      rudderSkillSync: { desiredSkills: ["org/build-advisor"] },
    }));
  });

  it("applies a conversation effort override while preserving the Agent runtime config", async () => {
    const modelFallbacks = [{
      agentRuntimeType: "codex_local",
      model: "gpt-5.4-mini",
    }];
    mockRunContextService.prepareRuntimeConfig.mockResolvedValueOnce({
      resolvedConfig: {},
      runtimeConfig: {
        model: "gpt-5.6-sol",
        modelReasoningEffort: "medium",
        modelFallbacks,
        cwd: "/tmp/chat-workspace",
      },
      runtimeSkillEntries: [],
      secretKeys: new Set(),
    });
    const svc = chatAssistantService({} as any);

    await svc.generateChatAssistantReply({
      conversation: makeConversation({ effortOverride: "xhigh" }),
      messages: makeMessages(),
      contextLinks: [],
    });

    const runtimeConfig = mockAdapter.execute.mock.calls.at(-1)?.[0]?.config as Record<string, unknown>;
    expect(runtimeConfig).toEqual(expect.objectContaining({
      model: "gpt-5.6-sol",
      modelReasoningEffort: "xhigh",
      modelFallbacks,
      cwd: "/tmp/chat-workspace",
    }));
  });

  it("freezes an explicit Auto effort snapshot for an admitted turn", async () => {
    mockRunContextService.prepareRuntimeConfig.mockResolvedValueOnce({
      resolvedConfig: {},
      runtimeConfig: {
        model: "gpt-5.6-sol",
        modelReasoningEffort: "high",
        reasoningEffort: "high",
      },
      runtimeSkillEntries: [],
      secretKeys: new Set(),
    });
    const svc = chatAssistantService({} as any);

    await svc.generateChatAssistantReply({
      conversation: makeConversation({ effortOverride: "xhigh" }),
      messages: makeMessages(),
      contextLinks: [],
      effortSnapshot: null,
    });

    const runtimeConfig = mockAdapter.execute.mock.calls.at(-1)?.[0]?.config as Record<string, unknown>;
    expect(runtimeConfig).not.toHaveProperty("modelReasoningEffort");
    expect(runtimeConfig).not.toHaveProperty("reasoningEffort");
  });

  it("prefers an admitted model snapshot and resets only an incompatible inherited effort", async () => {
    const modelFallbacks = [{
      agentRuntimeType: "codex_local",
      model: "gpt-5.4-mini",
    }];
    mockRunContextService.prepareRuntimeConfig.mockResolvedValueOnce({
      resolvedConfig: {},
      runtimeConfig: {
        model: "gpt-5.4",
        modelReasoningEffort: "ultra",
        reasoningEffort: "ultra",
        modelFallbacks,
        cwd: "/tmp/chat-workspace",
      },
      runtimeSkillEntries: [],
      secretKeys: new Set(),
    });
    const svc = chatAssistantService({} as any);

    await svc.generateChatAssistantReply({
      conversation: makeConversation({ modelOverride: "gpt-5.6-sol" }),
      messages: makeMessages(),
      contextLinks: [],
      modelSnapshot: "gpt-5.5",
    });

    const runtimeConfig = mockAdapter.execute.mock.calls.at(-1)?.[0]?.config as Record<string, unknown>;
    expect(runtimeConfig).toEqual(expect.objectContaining({
      model: "gpt-5.5",
      modelFallbacks,
      cwd: "/tmp/chat-workspace",
    }));
    expect(runtimeConfig).not.toHaveProperty("modelReasoningEffort");
    expect(runtimeConfig).not.toHaveProperty("reasoningEffort");
  });

  it("applies plan-mode prompt guidance and a structured Claude permission overlay", async () => {
    const svc = chatAssistantService({} as any);
    mockAgentService.getInternalById.mockResolvedValueOnce({
      id: "agent-1",
      orgId: "organization-1",
      name: "Claude Planner",
      status: "idle",
      agentRuntimeType: "claude_local",
      agentRuntimeConfig: {
        model: "claude-sonnet-4.5",
        dangerouslySkipPermissions: true,
        extraArgs: ["--permission-mode", "bypassPermissions", "--dangerously-skip-permissions"],
      },
      metadata: null,
    });
    mockRunContextService.prepareRuntimeConfig.mockResolvedValueOnce({
      resolvedConfig: {
        model: "claude-sonnet-4.5",
        dangerouslySkipPermissions: true,
        extraArgs: ["--permission-mode", "bypassPermissions", "--dangerously-skip-permissions"],
      },
      runtimeConfig: {
        model: "claude-sonnet-4.5",
        dangerouslySkipPermissions: true,
        extraArgs: ["--permission-mode", "bypassPermissions", "--dangerously-skip-permissions"],
        rudderSkillSync: { desiredSkills: [] },
        paperclipSkillSync: { desiredSkills: [] },
        rudderRuntimeSkills: [],
        paperclipRuntimeSkills: [],
      },
      runtimeSkillEntries: [],
      secretKeys: new Set(),
    });

    await svc.generateChatAssistantReply({
      conversation: makeConversation({
        planMode: true,
        chatRuntime: {
          sourceType: "agent",
          sourceLabel: "Claude Planner",
          runtimeAgentId: "agent-1",
          agentRuntimeType: "claude_local",
          model: "claude-sonnet-4.5",
          available: true,
          error: null,
        },
      }),
      messages: makeMessages(),
      contextLinks: [],
      operatorProfile: null,
    });

    const prompt = mockAdapter.execute.mock.calls.at(-1)?.[0]?.context?.chatPrompt as string;
    const runtimeConfig = mockAdapter.execute.mock.calls.at(-1)?.[0]?.config as Record<string, unknown>;
    expect(prompt).toContain("Plan mode is active for this conversation.");
    expect(runtimeConfig).toEqual(expect.objectContaining({
      dangerouslySkipPermissions: false,
      permissionMode: "plan",
      extraArgs: [],
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
    expect(prompt).not.toContain("issue plan document");
    expect(prompt).not.toContain("\"body\": \"optional markdown plan\"");
  });

  it("marks automation-run user messages as existing execution input instead of automation creation intent", async () => {
    const svc = chatAssistantService({} as any);

    await svc.generateChatAssistantReply({
      conversation: makeConversation({ title: "Daily information flow" }),
      messages: [makeAutomationRunInputMessage()],
      contextLinks: [],
      operatorProfile: null,
    });

    const prompt = mockAdapter.execute.mock.calls.at(-1)?.[0]?.context?.chatPrompt as string;
    expect(prompt).toContain("Automation execution context:");
    expect(prompt).toContain("already-created automation");
    expect(prompt).toContain("Do not emit result kind \"automation_create\" because of an automation-run input.");
    expect(prompt).toContain("Do not ask for schedule, trigger source, recurrence, or push time");
    expect(prompt).toContain("Use result kind 'automation_create' only when the latest operator-authored user request");
    expect(prompt).toContain("\"eventType\": \"automation_run_input\"");
    expect(prompt).toContain("\"mayCreateAutomation\": false");
    expect(prompt).toContain("For this automation-run input, mayCreateAutomation: false.");
  });

  it("keeps automation-run execution context when the operator answers an ask_user follow-up", async () => {
    const svc = chatAssistantService({} as any);
    const now = new Date("2026-03-29T08:02:00.000Z");
    const automationInput = makeAutomationRunInputMessage({
      chatTurnId: "turn-automation-run",
      createdAt: new Date("2026-03-29T08:01:00.000Z"),
      updatedAt: new Date("2026-03-29T08:01:00.000Z"),
    });
    const assistantQuestion: ChatMessage = {
      ...automationInput,
      id: "message-ask",
      role: "assistant",
      kind: "ask_user",
      body: "Which account should I summarize?",
      replyingAgentId: "agent-1",
      structuredPayload: {
        requestUserInput: {
          questions: [{
            id: "account",
            question: "Which account should I summarize?",
            options: [{ id: "all", label: "All accounts" }],
          }],
        },
      },
      createdAt: now,
      updatedAt: now,
    };
    const operatorAnswer: ChatMessage = {
      ...automationInput,
      id: "message-answer",
      body: "Use all accounts.",
      structuredPayload: null,
      chatTurnId: "turn-answer",
      createdAt: new Date("2026-03-29T08:03:00.000Z"),
      updatedAt: new Date("2026-03-29T08:03:00.000Z"),
    };

    await svc.generateChatAssistantReply({
      conversation: makeConversation({ title: "Daily information flow" }),
      messages: [automationInput, assistantQuestion, operatorAnswer],
      contextLinks: [],
      operatorProfile: null,
    });

    const prompt = mockAdapter.execute.mock.calls.at(-1)?.[0]?.context?.chatPrompt as string;
    expect(prompt).toContain("Automation execution context:");
    expect(prompt).toContain("Do not interpret an automation-run input as an operator-authored request");
    expect(prompt).toContain("Do not emit result kind \"automation_create\" because of an automation-run input.");
    expect(prompt).toContain("\"body\": \"Use all accounts.\"");
    expect(prompt).toContain("\"eventType\": \"automation_run_input\"");
  });

  it("returns a normal message for daily automation-run wording when the prompt carries the execution guard", async () => {
    const svc = chatAssistantService({} as any);
    mockAdapter.execute.mockImplementationOnce(async (ctx) => {
      const prompt = String(ctx.context?.chatPrompt ?? "");
      const hasAutomationRunGuard =
        prompt.includes("structuredPayload.eventType = \"automation_run_input\"")
        && prompt.includes("Do not emit result kind \"automation_create\" because of an automation-run input.");
      const sentinel = sentinelFromContext(ctx);
      return {
        summary: `${sentinel}${JSON.stringify(hasAutomationRunGuard
          ? {
            kind: "message",
            body: "Here is today's information flow.",
            structuredPayload: null,
          }
          : {
            kind: "automation_create",
            body: "I can create that automation.",
            structuredPayload: {
              automationCreate: {
                title: "Daily information flow",
                instructions: "Send a daily information flow.",
                priority: "medium",
                outputMode: "chat_output",
                schedule: {
                  cronExpression: "0 9 * * *",
                  timezone: "Asia/Shanghai",
                },
              },
            },
          })}`,
        resultJson: null,
        timedOut: false,
        exitCode: 0,
        errorMessage: null,
      };
    });

    const result = await svc.generateChatAssistantReply({
      conversation: makeConversation({ title: "Daily information flow" }),
      messages: [makeAutomationRunInputMessage()],
      contextLinks: [],
      operatorProfile: null,
    });

    expect(result).toEqual(expect.objectContaining({
      kind: "message",
      body: "Here is today's information flow.",
      structuredPayload: null,
    }));
  });

  it("parses ask_user final results and includes requestUserInput guidance in normal chat", async () => {
    const svc = chatAssistantService({} as any);
    mockAdapter.execute.mockImplementationOnce(async (ctx) => ({
      summary: askUserSummary(ctx),
      resultJson: null,
      timedOut: false,
      exitCode: 0,
      errorMessage: null,
    }));

    const result = await svc.generateChatAssistantReply({
      conversation: makeConversation({ planMode: false }),
      messages: makeMessages(),
      contextLinks: [],
      operatorProfile: null,
    });

    const prompt = mockAdapter.execute.mock.calls.at(-1)?.[0]?.context?.chatPrompt as string;
    expect(prompt).toContain("Use result kind 'ask_user'");
    expect(prompt).toContain("requestUserInput");
    expect(result).toEqual(expect.objectContaining({
      kind: "ask_user",
      body: "I need one decision before continuing.",
      structuredPayload: expect.objectContaining({
        requestUserInput: expect.objectContaining({
          questions: [expect.objectContaining({ id: "scope" })],
        }),
      }),
    }));
  });

  it("downgrades ask_user without requestUserInput to a normal message", async () => {
    const svc = chatAssistantService({} as any);
    mockAdapter.execute.mockImplementationOnce(async (ctx) => ({
      summary: `${sentinelFromContext(ctx)}${JSON.stringify({
        kind: "ask_user",
        body: "I need input.",
        structuredPayload: null,
      })}`,
      resultJson: null,
      timedOut: false,
      exitCode: 0,
      errorMessage: null,
    }));

    await expect(svc.generateChatAssistantReply({
      conversation: makeConversation(),
      messages: makeMessages(),
      contextLinks: [],
      operatorProfile: null,
    })).resolves.toEqual(expect.objectContaining({
      kind: "message",
      body: "I need input.",
      structuredPayload: null,
    }));
  });

  it.each([
    ["string", "requestUserInput"],
    ["array", [{ requestUserInput: { questions: [] } }]],
    ["number", 42],
    ["empty object", {}],
  ])("rejects ask_user with a present but invalid %s structuredPayload", (_label, structuredPayload) => {
    expect(() => validateAssistantResult({
      kind: "ask_user",
      body: "I need input.",
      structuredPayload,
    })).toThrow("ask_user assistant responses require structuredPayload.requestUserInput");
  });

  it.each([
    ["question ids", {
      requestUserInput: {
        questions: [
          {
            id: "scope",
            question: "Which scope should I use?",
            options: [
              { id: "narrow", label: "Narrow" },
              { id: "broad", label: "Broad" },
            ],
          },
          {
            id: "scope",
            question: "Which fallback should I use?",
            options: [
              { id: "wait", label: "Wait" },
              { id: "ship", label: "Ship" },
            ],
          },
        ],
      },
    }],
    ["option ids", {
      requestUserInput: {
        questions: [
          {
            id: "scope",
            question: "Which scope should I use?",
            options: [
              { id: "narrow", label: "Narrow" },
              { id: "narrow", label: "Also narrow" },
            ],
          },
        ],
      },
    }],
  ])("rejects ask_user final results with duplicate requestUserInput %s", async (_label, structuredPayload) => {
    const svc = chatAssistantService({} as any);
    mockAdapter.execute.mockImplementationOnce(async (ctx) => ({
      summary: `${sentinelFromContext(ctx)}${JSON.stringify({
        kind: "ask_user",
        body: "I need one decision.",
        structuredPayload,
      })}`,
      resultJson: null,
      timedOut: false,
      exitCode: 0,
      errorMessage: null,
    }));

    await expect(svc.generateChatAssistantReply({
      conversation: makeConversation(),
      messages: makeMessages(),
      contextLinks: [],
      operatorProfile: null,
    })).rejects.toThrow("ask_user assistant responses require structuredPayload.requestUserInput");
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
    mockRunContextService.buildSceneContext.mockResolvedValueOnce(makeSceneContext({
        cwd: process.cwd(),
        source: "project_primary",
        orgResourcesPrompt: "## Organization Resources\n\n- Main codebase: ~/projects/rudder",
    }));

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

  it("includes available issue labels and labelIds schema guidance for issue proposals", async () => {
    const svc = chatAssistantService({} as any);

    await svc.generateChatAssistantReply({
      conversation: makeConversation(),
      messages: makeMessages(),
      contextLinks: [],
      issueLabels: [
        { id: "11111111-1111-4111-8111-111111111111", orgId: "organization-1", name: "Engineering", color: "#0f766e", createdAt: new Date(), updatedAt: new Date() },
        { id: "22222222-2222-4222-8222-222222222222", orgId: "organization-1", name: "Operations", color: "#2563eb", createdAt: new Date(), updatedAt: new Date() },
        { id: "33333333-3333-4333-8333-333333333333", orgId: "organization-1", name: "Design", color: "#4338ca", createdAt: new Date(), updatedAt: new Date() },
        { id: "44444444-4444-4444-8444-444444444444", orgId: "organization-1", name: "Growth", color: "#c2410c", createdAt: new Date(), updatedAt: new Date() },
        { id: "55555555-5555-4555-8555-555555555555", orgId: "organization-1", name: "Support", color: "#a21caf", createdAt: new Date(), updatedAt: new Date() },
      ],
      operatorProfile: null,
    });

    const prompt = mockAdapter.execute.mock.calls.at(-1)?.[0]?.context?.chatPrompt as string;
    expect(prompt).toContain("Organization issue labels:");
    expect(prompt).toContain("- Engineering (11111111-1111-4111-8111-111111111111)");
    expect(prompt).toContain("include labelIds with at least one best-fit label id");
    expect(prompt).toContain('"labelIds": [');
    expect(prompt).toContain("assigneeUnassignedReason");
  });

  it("instructs chat agents not to propose issues unless the operator asks for issue creation", async () => {
    const svc = chatAssistantService({} as any);

    await svc.generateChatAssistantReply({
      conversation: makeConversation(),
      messages: makeMessages(),
      contextLinks: [],
      operatorProfile: null,
    });

    const prompt = mockAdapter.execute.mock.calls.at(-1)?.[0]?.context?.chatPrompt as string;
    expect(prompt).toContain("Do not emit issue_proposal just because work is large");
    expect(prompt).toContain("the latest operator-authored user request explicitly asks");
    expect(prompt).toContain("creating an issue");
    expect(prompt).toContain("converting the chat to an issue");
  });

  it("instructs initial issue proposals to preserve only relevant original images with canonical content paths", async () => {
    const svc = chatAssistantService({} as any);

    await svc.generateChatAssistantReply({
      conversation: makeConversation(),
      messages: makeMessages(),
      contextLinks: [],
      operatorProfile: null,
    });

    const prompt = mockAdapter.execute.mock.calls.at(-1)?.[0]?.context?.chatPrompt as string;
    expect(prompt).toContain("For initial and revised issue proposals, preserve a user-provided original image");
    expect(prompt).toContain("Prefer the original image over a redraw, generated replacement, or text-only substitute.");
    expect(prompt).toContain("using only the attachment's canonical contentPath as the target");
    expect(prompt).toContain("![Current broken state](/api/assets/<asset-id>/content)");
    expect(prompt).toContain("localPath is temporary runtime inspection context only");
    expect(prompt).toContain("must never appear in user-visible proposal JSON or Markdown");
    expect(prompt).toContain("Choose proposal images by relevance; do not copy every attachment indiscriminately.");
    expect(prompt).toContain("has no usable contentPath");
    expect(prompt).toContain("Never expose an internal download command, authentication material, or a fabricated image target.");
  });

  it("instructs revision proposals to recover relevant historical images without exposing local paths", async () => {
    const storage = makeStorageService();
    const svc = chatAssistantService({} as any, storage as any);
    const [originalMessage] = makeMessages();
    const originalImage = makeAttachment({
      id: "attachment-original-evidence",
      assetId: "asset-original-evidence",
      messageId: originalMessage!.id,
      originalFilename: "original-evidence.png",
      contentPath: "/api/assets/asset-original-evidence/content",
    });
    const revisionFeedback: ChatMessage = {
      ...originalMessage!,
      id: "message-revision-feedback",
      body: [
        'Please revise the proposal "Preserve evidence".',
        "",
        "Requested changes:",
        "Include the relevant original image.",
      ].join("\n"),
      attachments: [],
      createdAt: new Date("2026-03-29T08:02:00.000Z"),
      updatedAt: new Date("2026-03-29T08:02:00.000Z"),
    };

    await svc.generateChatAssistantReply({
      conversation: makeConversation(),
      messages: [{ ...originalMessage!, attachments: [originalImage] }, revisionFeedback],
      contextLinks: [],
      operatorProfile: null,
    });

    const prompt = mockAdapter.execute.mock.calls.at(-1)?.[0]?.context?.chatPrompt as string;
    expect(prompt).toContain("When revising an issue proposal, re-check relevant user image attachments across the available recentMessages history");
    expect(prompt).toContain("even when the latest revision-feedback message has no attachments");
    expect(prompt).toContain('"name": "original-evidence.png"');
    expect(prompt).toContain('"contentPath": "/api/assets/asset-original-evidence/content"');
    expect(prompt).toMatch(/"localPath": ".*original-evidence\.png"/);
    expect(prompt).toContain("Apply the same canonical contentPath, relevance, alt-text, and no-localPath rules");
    expect(prompt).not.toContain("Current user message attachments:");
  });

  it("rejects issue proposal results without an explicit owner decision", () => {
    expect(() => validateAssistantResult({
      kind: "issue_proposal",
      body: "This should become an issue.",
      structuredPayload: {
        issueProposal: {
          title: "Investigate unclear work",
          description: "The proposal omits owner assignment.",
          priority: "medium",
        },
      },
    })).toThrow("explicit owner decision");

    expect(validateAssistantResult({
      kind: "issue_proposal",
      body: "This should become an issue.",
      structuredPayload: {
        issueProposal: {
          title: "Investigate unclear work",
          description: "The proposal explicitly leaves ownership for review.",
          priority: "medium",
          assigneeUnassignedReason: "No suitable execution owner is known from the conversation.",
        },
      },
    })).toMatchObject({
      kind: "issue_proposal",
    });
  });

  it("rejects temporary local paths and unavailable, non-image, or fabricated image targets in issue proposals", () => {
    const proposal = (description: string) => ({
      kind: "issue_proposal",
      body: "This should become an issue.",
      structuredPayload: {
        issueProposal: {
          title: "Preserve original evidence",
          description,
          priority: "medium",
          assigneeUnassignedReason: "Ownership needs board review.",
        },
      },
    });
    const validationOptions = {
      allowedProposalImageContentPaths: new Set([
        "/api/assets/asset-relevant/content",
      ]),
      forbiddenAttachmentLocalPaths: [
        "/tmp/rudder-chat-attachments-run/original-evidence.png",
      ],
    };

    expect(validateAssistantResult(
      proposal("![Relevant evidence](/api/assets/asset-relevant/content)"),
      validationOptions,
    )).toMatchObject({ kind: "issue_proposal" });
    expect(() => validateAssistantResult(
      proposal("Inspect `/tmp/rudder-chat-attachments-run/original-evidence.png`."),
      validationOptions,
    )).toThrow("must not expose temporary attachment localPath values");
    expect(() => validateAssistantResult(
      proposal("![Fabricated evidence](/api/assets/asset-not-in-context/content)"),
      validationOptions,
    )).toThrow("must use a canonical contentPath from an available user image attachment");
    expect(() => validateAssistantResult(
      proposal("![Non-image attachment](/api/assets/asset-document/content)"),
      validationOptions,
    )).toThrow("must use a canonical contentPath from an available user image attachment");
    expect(() => validateAssistantResult(
      proposal("![Missing canonical path](/api/assets/asset-without-content-path/content)"),
      validationOptions,
    )).toThrow("must use a canonical contentPath from an available user image attachment");
    expect(() => validateAssistantResult(
      proposal("![Runtime file](file:///tmp/original-evidence.png)"),
      validationOptions,
    )).toThrow("must use a canonical contentPath from an available user image attachment");
    expect(() => validateAssistantResult(
      proposal("![Runtime file][evidence]\n\n[evidence]: file:///tmp/original-evidence.png"),
      validationOptions,
    )).toThrow("must use a canonical contentPath from an available user image attachment");
    expect(() => validateAssistantResult({
      ...proposal("No image is needed."),
      body: "Runtime inspection used /tmp/rudder-chat-attachments-run/original-evidence.png.",
    }, validationOptions)).toThrow("must not expose temporary attachment localPath values");
    expect(() => validateAssistantResult(
      proposal("Runtime inspection used `C:\\Temp\\rudder-chat-attachments-run\\original-evidence.png`."),
      {
        ...validationOptions,
        forbiddenAttachmentLocalPaths: [
          "C:\\Temp\\rudder-chat-attachments-run\\original-evidence.png",
        ],
      },
    )).toThrow("must not expose temporary attachment localPath values");
  });

  it("allows only user-provided image content paths from the bounded prompt window", () => {
    const [userMessage] = makeMessages();
    const userImage = makeAttachment({
      id: "attachment-user-image",
      assetId: "asset-user-image",
      messageId: userMessage!.id,
      contentPath: "/api/assets/asset-user-image/content",
    });
    const assistantImage = makeAttachment({
      id: "attachment-assistant-image",
      assetId: "asset-assistant-image",
      messageId: "message-assistant-image",
      contentPath: "/api/assets/asset-assistant-image/content",
    });
    const assistantMessage: ChatMessage = {
      ...userMessage!,
      id: "message-assistant-image",
      role: "assistant",
      attachments: [assistantImage],
    };

    expect([...userImageContentPathsFromMessages([
      { ...userMessage!, attachments: [userImage] },
      assistantMessage,
    ])]).toEqual([
      "/api/assets/asset-user-image/content",
    ]);
  });

  it("injects selected project context and project resources into chat prompts", async () => {
    const projectContextLink = makeProjectContextLink();
    mockRunContextService.buildSceneContext.mockResolvedValueOnce(makeSceneContext({
        cwd: process.cwd(),
        source: "project_primary",
        projectId: "project-1",
        orgResourcesPrompt: "## Project Context Resources\n\n- [primary] Launch playbook",
    }));

    const svc = chatAssistantService({} as any);

    await svc.generateChatAssistantReply({
      conversation: makeConversation({ contextLinks: [projectContextLink] }),
      messages: makeMessages(),
      contextLinks: [projectContextLink],
      operatorProfile: null,
    });

    expect(mockRunContextService.resolveWorkspaceForRun).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ projectId: "project-1" }),
      null,
    );
    const prompt = mockAdapter.execute.mock.calls.at(-1)?.[0]?.context?.chatPrompt as string;
    expect(prompt).toContain("Selected project context:");
    expect(prompt).toContain("- Project ID: project-1");
    expect(prompt).toContain("- Name: Launch Ops");
    expect(prompt).toContain("- Description: Coordinate the launch workflow.");
    expect(prompt).toContain("## Project Context Resources");
    expect(prompt).toContain("[primary] Launch playbook");
  });

  it("injects issue label choices and schema guidance for mature label taxonomies", async () => {
    const svc = chatAssistantService({} as any);

    await svc.generateChatAssistantReply({
      conversation: makeConversation(),
      messages: makeMessages(),
      contextLinks: [],
      issueLabels: Array.from({ length: 5 }, (_, index) => ({
        id: `label-${index + 1}`,
        orgId: "organization-1",
        name: index === 0 ? "Engineering" : `Label ${index + 1}`,
        color: "#2563eb",
        createdAt: new Date("2026-03-29T08:00:00.000Z"),
        updatedAt: new Date("2026-03-29T08:00:00.000Z"),
      })),
      operatorProfile: null,
    });

    const prompt = mockAdapter.execute.mock.calls.at(-1)?.[0]?.context?.chatPrompt as string;
    expect(prompt).toContain("Organization issue labels:");
    expect(prompt).toContain("- Engineering (label-1)");
    expect(prompt).toContain("include labelIds with at least one best-fit label id from this list");
    expect(prompt).toContain('"labelIds": [');
  });

  it("injects selected issue context into chat prompts and runtime context", async () => {
    const issueContextLink = makeIssueContextLink();
    const svc = chatAssistantService({} as any);

    await svc.generateChatAssistantReply({
      conversation: makeConversation({ contextLinks: [issueContextLink] }),
      messages: makeMessages(),
      contextLinks: [issueContextLink],
      operatorProfile: null,
    });

    expect(mockRunContextService.resolveWorkspaceForRun).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ issueId: "issue-1" }),
      null,
    );
    const executeInput = mockAdapter.execute.mock.calls.at(-1)?.[0];
    const prompt = executeInput?.context?.chatPrompt as string;
    expect(prompt).toContain("Selected issue context:");
    expect(prompt).toContain("- Issue ID: issue-1");
    expect(prompt).toContain("- Identifier: ISS-42");
    expect(prompt).toContain("- Title: Fix issue chat handoff");
    expect(prompt).toContain("- Status: in_progress");
    expect(prompt).toContain("- Priority: medium");
    expect(prompt).toContain("- Description: Clicking Chat from an issue should open a contextual new chat composer.");
    expect(executeInput?.context).toMatchObject({
      issueId: "issue-1",
      issueIds: ["issue-1"],
    });
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
        summary: assistantSummary(ctx, "Clarify the goal first."),
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
    const prompt = String((invocationMeta[0] as { prompt?: unknown }).prompt ?? "");
    const sentinel = prompt.match(/(__RUDDER_RESULT_[a-f0-9-]+__)/i)?.[1];
    expect(sentinel).toBeTruthy();
    expect(prompt.lastIndexOf("Conversation input:")).toBeLessThan(
      prompt.lastIndexOf("Final Rudder result reminder:"),
    );
    expect(prompt.trim()).toContain("RUDDER_RESULT_BEGIN\n<final answer body only>\nRUDDER_RESULT_END");
    expect(prompt.trim()).toContain(`Only use ${sentinel} plus JSON when the result kind is ask_user`);
  });

  it("finalizes a chat run when setup fails after creation so the conversation can retry immediately", async () => {
    const svc = chatAssistantService({} as any);
    let activeRunId: string | null = null;
    let runSequence = 0;

    mockRunContextService.buildSceneContext.mockResolvedValueOnce(makeSceneContext({
      agentHome: "",
    }));
    mockChatAgentRuns.createRun.mockImplementation(async () => {
      if (activeRunId) {
        throw new Error("A chat assistant run is already active for this conversation");
      }
      runSequence += 1;
      activeRunId = `chat-run-${runSequence}`;
      return {
        id: activeRunId,
        orgId: "organization-1",
        agentId: "agent-1",
        status: "running",
      };
    });
    mockChatAgentRuns.finalizeRun.mockImplementation(async (runId) => {
      if (activeRunId === runId) {
        activeRunId = null;
      }
      return undefined;
    });

    await expect(svc.generateChatAssistantReply({
      conversation: makeConversation(),
      messages: makeMessages(),
      contextLinks: [],
      operatorProfile: null,
    })).rejects.toThrow("managed agent_home path is missing");

    expect(mockAdapter.execute).not.toHaveBeenCalled();
    expect(mockChatAgentRuns.finalizeRun).toHaveBeenCalledWith(
      "chat-run-1",
      expect.objectContaining({
        status: "failed",
        errorCode: "managed_workspace_configuration_error",
      }),
    );

    const result = await svc.generateChatAssistantReply({
      conversation: makeConversation(),
      messages: makeMessages(),
      contextLinks: [],
      operatorProfile: null,
    });

    expect(result.body).toBe("Clarify the goal first.");
    expect(mockChatAgentRuns.createRun).toHaveBeenCalledTimes(2);
    expect(mockAdapter.execute).toHaveBeenCalledTimes(1);
    expect(mockChatAgentRuns.finalizeRun).toHaveBeenLastCalledWith(
      "chat-run-2",
      expect.objectContaining({ status: "succeeded" }),
    );
  });

  it("uses provider-aware model fallbacks for the selected chat agent runtime", async () => {
    const fallbackAdapter = {
      type: "claude_local",
      supportsLocalAgentJwt: true,
      parseStdoutLine: vi.fn(() => []),
      execute: vi.fn(async (ctx) => ({
        summary: assistantSummary(ctx, "Fallback handled the chat."),
        resultJson: null,
        timedOut: false,
        exitCode: 0,
        errorMessage: null,
      })),
    };
    const modelFallbacks = [{
      agentRuntimeType: "claude_local",
      model: "claude-sonnet-4-6",
      config: { effort: "high", command: "claude" },
    }];

    mockFindServerAdapter.mockImplementation((agentRuntimeType: string) =>
      agentRuntimeType === "claude_local" ? fallbackAdapter : mockAdapter,
    );
    mockRunContextService.prepareRuntimeConfig.mockResolvedValueOnce({
      resolvedConfig: { model: "gpt-primary", modelFallbacks },
      runtimeConfig: {
        model: "gpt-primary",
        modelFallbacks,
        rudderSkillSync: { desiredSkills: [] },
        paperclipSkillSync: { desiredSkills: [] },
        rudderRuntimeSkills: [],
        paperclipRuntimeSkills: [],
      },
      runtimeSkillEntries: [],
      secretKeys: new Set(),
    });
    mockAdapter.execute.mockResolvedValueOnce({
      summary: null,
      resultJson: null,
      timedOut: false,
      exitCode: 1,
      errorMessage: "primary model unavailable",
    });

    const svc = chatAssistantService({} as any);
    const result = await svc.generateChatAssistantReply({
      conversation: makeConversation(),
      messages: makeMessages(),
      contextLinks: [],
      operatorProfile: null,
    });

    expect(result.body).toBe("Fallback handled the chat.");
    expect(mockAdapter.execute).toHaveBeenCalledTimes(1);
    expect(fallbackAdapter.execute).toHaveBeenCalledTimes(1);
    expect(fallbackAdapter.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: expect.objectContaining({ agentRuntimeType: "claude_local" }),
        config: expect.objectContaining({
          model: "claude-sonnet-4-6",
          effort: "high",
          command: "claude",
        }),
      }),
    );
  });

  it("uses the preferred agent as the chat speaker and preserves prepared runtime context", async () => {
    mockAgentService.getInternalById.mockResolvedValueOnce({
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

  it("runs preferred-agent chat after workspace preflight and parses the result sentinel", async () => {
    const svc = chatAssistantService({} as any);

    const result = await svc.generateChatAssistantReply({
      conversation: makeConversation(),
      messages: makeMessages(),
      contextLinks: [],
      operatorProfile: null,
    });

    const executeInput = mockAdapter.execute.mock.calls.at(-1)?.[0];
    expect(executeInput?.context?.chatPrompt).toEqual(expect.stringContaining("You are Chat Specialist, replying inside Rudder's chat scene."));
    expect(mockAdapter.execute).toHaveBeenCalledTimes(1);
    expect(result).toEqual(expect.objectContaining({
      kind: "message",
      body: "Clarify the goal first.",
      replyingAgentId: "agent-1",
    }));
    await expect(fs.stat(path.join(currentAgentHome, "life")).then((stat) => stat.isDirectory())).resolves.toBe(true);
    await expect(fs.stat(path.join(currentAgentHome, "skills")).then((stat) => stat.isDirectory())).resolves.toBe(true);
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
    expect(mockRunContextService.materializeManagedInstructionsForRun).not.toHaveBeenCalled();
    expect(mockRunContextService.prepareRuntimeConfig).toHaveBeenCalledWith(expect.not.objectContaining({
      materializeManagedInstructions: true,
    }));
  });

  it("materializes managed instructions before executing a chat reply", async () => {
    mockAgentService.getInternalById.mockResolvedValueOnce({
      id: "agent-1",
      orgId: "organization-1",
      name: "Chat Specialist",
      role: "ceo",
      workspaceKey: "chat-specialist--agent-1",
      status: "idle",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: { model: "gpt-5.4", instructionsBundleMode: "managed" },
      metadata: null,
    });
    mockRunContextService.materializeManagedInstructionsForRun.mockResolvedValueOnce({
      model: "gpt-5.4",
      instructionsBundleMode: "managed",
      instructionsRootPath: "/tmp/chat-specialist/instructions",
      instructionsEntryFile: "SOUL.md",
      instructionsFilePath: "/tmp/chat-specialist/instructions/SOUL.md",
    });

    const svc = chatAssistantService({} as any);
    await svc.generateChatAssistantReply({
      conversation: makeConversation(),
      messages: makeMessages(),
      contextLinks: [],
    });

    expect(mockRunContextService.materializeManagedInstructionsForRun).toHaveBeenCalledWith(expect.objectContaining({
      id: "agent-1",
      role: "ceo",
      workspaceKey: "chat-specialist--agent-1",
      agentRuntimeConfig: expect.objectContaining({ instructionsBundleMode: "managed" }),
    }));
    expect(mockRunContextService.prepareRuntimeConfig).toHaveBeenCalledWith(expect.objectContaining({
      scene: "chat",
      materializeMissingRuntimeSkills: true,
      agent: expect.objectContaining({
        workspaceKey: "chat-specialist--agent-1",
        agentRuntimeConfig: expect.objectContaining({
          instructionsRootPath: "/tmp/chat-specialist/instructions",
          instructionsFilePath: "/tmp/chat-specialist/instructions/SOUL.md",
        }),
      }),
    }));
  });

  it("translates runtime skill preparation failures into sanitized actionable stream errors", async () => {
    mockRunContextService.prepareRuntimeConfig.mockRejectedValueOnce(
      new Error(
        "Could not install organization skill build-advisor from "
        + "/Users/alice/.rudder/skills/build-advisor/SKILL.md?token=secret-token.json "
        + "credential=/private/second-secret.yaml",
      ),
    );

    const svc = chatAssistantService({} as any);
    const error = await svc.streamChatAssistantReply({
      conversation: makeConversation(),
      messages: makeMessages(),
      contextLinks: [],
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(ChatAssistantStreamError);
    expect(error).toMatchObject({
      errorCode: "chat_runtime_preparation_failed",
      userMessage:
        'Could not prepare organization skill "build-advisor" file "SKILL.md". '
        + "Check that its installed files are available, then retry.",
      retryable: true,
      failurePhase: "runtime_boot",
      action: "retry",
    });
    expect(error.message).not.toContain("/Users/alice");
    expect(error.message).not.toContain("secret-token.json");
    expect(error.message).not.toContain("second-secret.yaml");
    expect(error.userMessage).not.toContain("/Users/alice");
    expect(error.userMessage).not.toContain("secret-token.json");
    expect(error.userMessage).not.toContain("second-secret.yaml");
    expect(mockChatAgentRuns.createRun).not.toHaveBeenCalled();
    expect(mockAdapter.execute).not.toHaveBeenCalled();
  });

  it("does not infer a preparation filename from arbitrary typed error paths", async () => {
    mockRunContextService.prepareRuntimeConfig.mockRejectedValueOnce(
      new ChatAssistantStreamError(
        "Preparation failed at path=/private/secret-token.json?token=credential.yaml",
        "",
        [],
        {
          errorCode: "chat_runtime_preparation_failed",
          userMessage: "unsafe typed message",
          retryable: false,
          failurePhase: "runtime_boot",
          action: "repair_runtime",
        },
      ),
    );

    const svc = chatAssistantService({} as any);
    const error = await svc.streamChatAssistantReply({
      conversation: makeConversation(),
      messages: makeMessages(),
      contextLinks: [],
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(ChatAssistantStreamError);
    expect(error).toMatchObject({
      userMessage:
        "Could not prepare the configured runtime skills or files. "
        + "Check the agent runtime and skill configuration, then retry.",
      retryable: true,
      action: "retry",
    });
    expect(error.message).not.toContain("secret-token.json");
    expect(error.message).not.toContain("credential.yaml");
    expect(error.userMessage).not.toContain("secret-token.json");
    expect(error.userMessage).not.toContain("credential.yaml");
  });

  it("streams assistant progress through transcript entries and final body through deltas", async () => {
    const svc = chatAssistantService({} as any);
    const deltas: string[] = [];
    const entries: Array<{ kind: string; text?: string }> = [];
    const states: string[] = [];

    mockAdapter.execute.mockImplementationOnce(async (ctx) => {
      const prompt = String(ctx.context.chatPrompt);
      const sentinel = prompt.match(/(__RUDDER_RESULT_[a-f0-9-]+__)/i)?.[1] ?? "__RUDDER_RESULT_TEST__";
      const finalText =
        `Checking the success criteria first.\n${sentinel}${JSON.stringify({
          kind: "message",
          body: "Clarify the success criteria first.",
          structuredPayload: null,
        })}`;

      await ctx.onLog(
        "stdout",
        `${JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "Checking the success " },
        })}\n`,
      );
      await ctx.onLog(
        "stdout",
        `${JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "criteria first." },
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
      onTranscriptEntry: (entry) => {
        entries.push(entry);
      },
      onAssistantState: (state) => {
        states.push(state);
      },
    });

    expect(result).toEqual({
      outcome: "completed",
      partialBody: "Clarify the success criteria first.",
      replyingAgentId: "agent-1",
      reply: {
        kind: "message",
        body: "Clarify the success criteria first.",
        structuredPayload: null,
        replyingAgentId: "agent-1",
      },
    });
    expect(entries).toEqual([
      expect.objectContaining({ kind: "assistant", text: "Checking the success " }),
      expect.objectContaining({ kind: "assistant", text: "criteria first." }),
    ]);
    expect(deltas.join("")).toBe("Clarify the success criteria first.");
    expect(deltas.join("")).not.toContain("__RUDDER_RESULT_");
    expect(states).toEqual(["streaming", "finalizing"]);
  });

  it("never projects raw runtime-neutral visual bytes to Chat-visible stream or run result surfaces", async () => {
    const svc = chatAssistantService({} as any);
    const deltas: string[] = [];
    const entries: Array<{ kind: string; text?: string }> = [];
    const observedEntries: Array<{ kind: string; text?: string }> = [];
    const fragment = '<div id="widget"><span>PRIVATE_VISUAL_BYTES</span></div>';

    mockAdapter.execute.mockImplementationOnce(async (ctx) => {
      const finalText = [
        "RUDDER_RESULT_BEGIN",
        "Q4 Capacity Scenarios",
        ":::rudder-inline-visual:v1",
        fragment,
        ":::rudder-inline-visual:end",
        "RUDDER_RESULT_END",
      ].join("\n");
      for (const chunk of [finalText.slice(0, 37), finalText.slice(37, 71), finalText.slice(71)]) {
        await ctx.onLog(
          "stdout",
          `${JSON.stringify({
            type: "item.completed",
            item: { type: "agent_message", text: chunk },
          })}\n`,
        );
      }
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
      onAssistantDelta: (delta) => deltas.push(delta),
      onTranscriptEntry: (entry) => entries.push(entry),
      onObservedTranscriptEntry: (entry) => observedEntries.push(entry),
    });

    expect(result.outcome).toBe("completed");
    if (result.outcome !== "completed") throw new Error("expected completed");
    expect(result.reply.body).toBe('Q4 Capacity Scenarios\n::rudder-inline-vis{slot="0"}');
    expect(result.reply.generatedAttachments?.[0]?.body.toString("utf8")).toBe(fragment);
    for (const publicSurface of [
      deltas.join(""),
      JSON.stringify(entries),
      JSON.stringify(observedEntries),
      JSON.stringify(mockChatAgentRuns.finalizeRun.mock.calls),
    ]) {
      expect(publicSurface).not.toContain("PRIVATE_VISUAL_BYTES");
      expect(publicSurface).not.toContain("<div id=\"widget\"");
    }
  });

  it("quarantines nested visual source through the matching outer end", async () => {
    const svc = chatAssistantService({} as any);
    const deltas: string[] = [];
    const entries: Array<{ kind: string; text?: string }> = [];
    const finalText = [
      "RUDDER_RESULT_BEGIN",
      "Before",
      ":::rudder-inline-visual:v1",
      "PRIVATE_OUTER",
      ":::rudder-inline-visual:v1",
      "PRIVATE_INNER",
      ":::rudder-inline-visual:end",
      "PRIVATE_AFTER_INNER_END",
      ":::rudder-inline-visual:end",
      "After",
      "RUDDER_RESULT_END",
    ].join("\n");

    mockAdapter.execute.mockImplementationOnce(async (ctx) => {
      for (let index = 0; index < finalText.length; index += 7) {
        await ctx.onLog(
          "stdout",
          `${JSON.stringify({
            type: "item.completed",
            item: { type: "agent_message", text: finalText.slice(index, index + 7) },
          })}\n`,
        );
      }
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
      onAssistantDelta: (delta) => deltas.push(delta),
      onTranscriptEntry: (entry) => entries.push(entry),
    });

    expect(result.outcome).toBe("completed");
    if (result.outcome !== "completed") throw new Error("expected completed");
    expect(result.reply.body).toBe('Before\n::rudder-inline-vis{slot="0"}\nAfter');
    expect(result.reply.generatedAttachments).toBeUndefined();
    expect(result.reply.inlineVisualsV1).toEqual([
      expect.objectContaining({ slot: 0, status: "unavailable", reason: "nested" }),
    ]);
    for (const surface of [
      deltas.join(""),
      JSON.stringify(entries),
      JSON.stringify(mockChatAgentRuns.appendTranscriptEntry.mock.calls),
      JSON.stringify(mockChatAgentRuns.finalizeRun.mock.calls),
    ]) {
      expect(surface).not.toContain("PRIVATE_");
      expect(surface).not.toContain(":::rudder-inline-visual");
    }
  });

  it("uses one stateful source filter for diagnostic transcript entries and Rudder stdout", async () => {
    const svc = chatAssistantService({} as any);
    const transcriptEntries: Array<{ kind: string; text?: string; content?: string }> = [];
    const observedEntries: Array<{ kind: string; text?: string; content?: string }> = [];

    mockAdapter.execute.mockImplementationOnce(async (ctx) => {
      const diagnosticSource = [
        ":::rudder-inline-visual:v1",
        '<div id="widget">PRIVATE_SPLIT_TRANSCRIPT</div>',
        ":::rudder-inline-visual:end",
      ].join("\n") + "\n";
      for (let index = 0; index < diagnosticSource.length; index += 7) {
        await ctx.onLog(
          "stdout",
          `${JSON.stringify({
            type: "item.completed",
            item: {
              type: "reasoning",
              text: diagnosticSource.slice(index, index + 7),
              delta: true,
            },
          })}\n`,
        );
      }
      const standaloneDeltaSource = '<div id="widget">PRIVATE_STANDALONE_DELTA</div>';
      for (let index = 0; index < standaloneDeltaSource.length; index += 7) {
        await ctx.onLog(
          "stdout",
          `${JSON.stringify({
            type: "item.completed",
            item: {
              type: "reasoning",
              text: standaloneDeltaSource.slice(index, index + 7),
              delta: true,
            },
          })}\n`,
        );
      }
      await ctx.onLog(
        "stdout",
        [
          "[rudder] diagnostic",
          ":::rudder-inline-visual:v1",
          '<div id="widget">PRIVATE_RUDDER_STDOUT</div>',
          ":::rudder-inline-visual:end",
          "Visible diagnostic",
        ].join("\n"),
      );
      await ctx.onLog(
        "stdout",
        `${JSON.stringify({
          type: "item.started",
          item: {
            type: "tool_use",
            id: "tool-private",
            name: "inspect",
            input: {
              [[
                ":::rudder-inline-visual:v1",
                '<div id="widget">PRIVATE_TOOL_KEY</div>',
                ":::rudder-inline-visual:end",
              ].join("\n")]: "key source",
              payload: [
                ":::rudder-inline-visual:v1",
                '<div id="widget">PRIVATE_TOOL_INPUT</div>',
                ":::rudder-inline-visual:end",
              ].join("\n"),
              mixed: [
                ":::rudder-inline-visual:v1",
                '<div id="widget">PRIVATE_TOOL_ENVELOPE</div>',
                ":::rudder-inline-visual:end",
                '<div id="widget">PRIVATE_TOOL_OUTSIDE</div>',
              ].join("\n"),
            },
          },
        })}\n`,
      );
      await ctx.onLog(
        "stdout",
        `${JSON.stringify({
          type: "item.completed",
          item: {
            type: "reasoning",
            text: "Visible structured diagnostic",
            extra: '<div id="widget">PRIVATE_UNEXPECTED_FIELD</div>',
          },
        })}\n`,
      );
      await ctx.onLog(
        "stdout",
        `${JSON.stringify({
          type: "result",
          result: "Visible result diagnostic",
          subtype: '<div id="widget">PRIVATE_RESULT_SUBTYPE</div>',
          errors: [[
            ":::rudder-inline-visual:v1",
            '<div id="widget">PRIVATE_RESULT_ERROR</div>',
            ":::rudder-inline-visual:end",
          ].join("\n")],
        })}\n`,
      );
      await ctx.onLog(
        "stdout",
        `${JSON.stringify({
          type: "item.completed",
          item: {
            type: "todo_list",
            items: [
              { text: ":::rudder-inline-visual:v1", status: "pending" },
              { text: '<div id="widget">PRIVATE_TODO_TEXT</div>', status: "pending" },
              { text: ":::rudder-inline-visual:end", status: "pending" },
            ],
          },
        })}\n`,
      );
      return {
        summary: assistantSummary(ctx, "Safe final reply"),
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
      onTranscriptEntry: (entry) => transcriptEntries.push(entry),
      onObservedTranscriptEntry: (entry) => observedEntries.push(entry),
    });

    const surfaces = JSON.stringify({
      transcriptEntries,
      observedEntries,
      persisted: mockChatAgentRuns.appendTranscriptEntry.mock.calls,
    });
    expect(surfaces).toContain("Visible diagnostic");
    expect(surfaces).not.toContain("PRIVATE_SPLIT_TRANSCRIPT");
    expect(surfaces).not.toContain("PRIVATE_STANDALONE_DELTA");
    expect(surfaces).not.toContain("PRIVATE_RUDDER_STDOUT");
    expect(surfaces).not.toContain("PRIVATE_TOOL_INPUT");
    expect(surfaces).not.toContain("PRIVATE_TOOL_ENVELOPE");
    expect(surfaces).not.toContain("PRIVATE_TOOL_OUTSIDE");
    expect(surfaces).not.toContain("PRIVATE_TOOL_KEY");
    expect(surfaces).not.toContain("PRIVATE_TODO_TEXT");
    expect(surfaces).not.toContain("PRIVATE_RESULT_ERROR");
    expect(surfaces).not.toContain("PRIVATE_RESULT_SUBTYPE");
    expect(surfaces).not.toContain("PRIVATE_UNEXPECTED_FIELD");
    expect(surfaces).not.toContain(":::rudder-inline-visual");
  });

  it("redacts inline visual source from adapter failure messages and run evidence", async () => {
    const svc = chatAssistantService({} as any);
    const privateError = [
      "provider failed",
      ":::rudder-inline-visual:v1",
      '<div id="widget">PRIVATE_ADAPTER_ERROR</div>',
      ":::rudder-inline-visual:end",
    ].join("\n");

    mockAdapter.execute.mockImplementationOnce(async () => ({
      summary: "",
      resultJson: null,
      timedOut: false,
      exitCode: 1,
      errorMessage: privateError,
    }));

    const error = await svc.streamChatAssistantReply({
      conversation: makeConversation(),
      messages: makeMessages(),
      contextLinks: [],
    }).catch((reason) => reason);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("provider failed");
    expect(JSON.stringify(mockChatAgentRuns.finalizeRun.mock.calls)).not.toContain("PRIVATE_ADAPTER_ERROR");
    expect(JSON.stringify(error)).not.toContain("PRIVATE_ADAPTER_ERROR");
    expect(JSON.stringify(error)).not.toContain(":::rudder-inline-visual");
  });

  it("discards an unfinished visual buffer when the Chat run stops", async () => {
    const svc = chatAssistantService({} as any);
    const abortController = new AbortController();
    const deltas: string[] = [];
    const entries: Array<{ kind: string; text?: string }> = [];

    mockAdapter.execute.mockImplementationOnce(async (ctx) => {
      await ctx.onLog(
        "stdout",
        `${JSON.stringify({
          type: "item.completed",
          item: {
            type: "agent_message",
            text: "RUDDER_RESULT_BEGIN\nVisible heading\n:::rudder-inline-visual:v1\n<div id=\"widget\">PRIVATE_STOP_BYTES",
          },
        })}\n`,
      );
      abortController.abort();
      return {
        summary: "",
        resultJson: null,
        timedOut: false,
        exitCode: null,
        signal: "SIGTERM",
      };
    });

    const result = await svc.streamChatAssistantReply({
      conversation: makeConversation(),
      messages: makeMessages(),
      contextLinks: [],
      abortSignal: abortController.signal,
      onAssistantDelta: (delta) => deltas.push(delta),
      onTranscriptEntry: (entry) => entries.push(entry),
    });

    expect(result).toMatchObject({ outcome: "stopped" });
    expect(JSON.stringify({ result, deltas, entries })).not.toContain("PRIVATE_STOP_BYTES");
    expect(JSON.stringify(mockChatAgentRuns.finalizeRun.mock.calls)).not.toContain("PRIVATE_STOP_BYTES");
  });

  it("keeps phased Codex commentary in Process instead of promoting it into a stopped reply body", async () => {
    const svc = chatAssistantService({} as any);
    const abortController = new AbortController();
    const deltas: string[] = [];
    const entries: Array<{ kind: string; text?: string; phase?: string }> = [];

    mockAdapter.execute.mockImplementationOnce(async (ctx) => {
      await ctx.onLog(
        "stdout",
        `${JSON.stringify({
          type: "item.completed",
          item: {
            type: "agent_message",
            text: "I am still checking the timeline.",
            delta: true,
            phase: "commentary",
          },
        })}\n`,
      );
      abortController.abort();
      return {
        summary: "",
        resultJson: null,
        timedOut: false,
        exitCode: null,
        signal: "SIGTERM",
      };
    });

    const result = await svc.streamChatAssistantReply({
      conversation: makeConversation(),
      messages: makeMessages(),
      contextLinks: [],
      abortSignal: abortController.signal,
      onAssistantDelta: (delta) => deltas.push(delta),
      onTranscriptEntry: (entry) => entries.push(entry),
    });

    expect(result).toMatchObject({
      outcome: "stopped",
      partialBody: "",
    });
    expect(deltas).toEqual([]);
    expect(entries).toEqual([
      expect.objectContaining({
        kind: "assistant",
        text: "I am still checking the timeline.",
        phase: "commentary",
      }),
    ]);
  });

  it("forwards process transcript entries while streaming", async () => {
    const svc = chatAssistantService({} as any);
    const entries: Array<{ kind: string; text?: string; name?: string; toolUseId?: string }> = [];

    mockAdapter.execute.mockImplementationOnce(async (ctx) => {
      const prompt = String(ctx.context.chatPrompt);
      const sentinel = prompt.match(/(__RUDDER_RESULT_[a-f0-9-]+__)/i)?.[1] ?? "__RUDDER_RESULT_TEST__";
      await ctx.onLog(
        "stdout",
        `${JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "I am checking the chat surface first." },
        })}\n`,
      );
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
          item: { type: "agent_message", text: `${sentinel}${JSON.stringify({
            kind: "message",
            body: "Done.",
            structuredPayload: null,
          })}` },
        })}\n`,
      );

      return {
        summary: `${sentinel}${JSON.stringify({
          kind: "message",
          body: "Done.",
          structuredPayload: null,
        })}`,
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
      { kind: "assistant", text: "I am checking the chat surface first." },
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
        `Preparing the final chat reply.\n${sentinel}${JSON.stringify({
          kind: "message",
          body: "Hello Zeeland! I'm here to help clarify and route work requests. How can I assist you today?",
          structuredPayload: null,
        })}`;

      await ctx.onLog(
        "stdout",
        `${JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "Preparing the final chat reply." },
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
      replyingAgentId: "agent-1",
      reply: {
        kind: "message",
        body: "Hello Zeeland! I'm here to help clarify and route work requests. How can I assist you today?",
        structuredPayload: null,
        replyingAgentId: "agent-1",
      },
    });
    expect(entries).toEqual([
      expect.objectContaining({
        kind: "assistant",
        text: "Preparing the final chat reply.",
      }),
    ]);
    expect(observedEntries).toEqual([
      expect.objectContaining({
        kind: "assistant",
        text: "Preparing the final chat reply.",
      }),
      expect.objectContaining({
        kind: "result",
        text: "Preparing the final chat reply.",
      }),
    ]);
  });

  it("extracts Codex image generation output into generated chat attachments", async () => {
    const svc = chatAssistantService({} as any);
    const pngBase64 = Buffer.from("fake-png").toString("base64");

    mockAdapter.execute.mockImplementationOnce(async (ctx) => {
      const finalText = assistantSummary(ctx, "Generated a mockup.");
      const stdout = [
        JSON.stringify({
          type: "item.completed",
          item: {
            type: "image_generation_call",
            id: "ig_test",
            result: pngBase64,
          },
        }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: finalText },
        }),
      ].join("\n");

      return {
        summary: finalText,
        resultJson: { stdout },
        timedOut: false,
        exitCode: 0,
        errorMessage: null,
      };
    });

    const result = await svc.streamChatAssistantReply({
      conversation: makeConversation(),
      messages: makeMessages(),
      contextLinks: [],
    });

    expect(result.outcome).toBe("completed");
    if (result.outcome !== "completed") throw new Error("expected completed");
    expect(result.reply.generatedAttachments).toHaveLength(1);
    expect(result.reply.generatedAttachments?.[0]).toMatchObject({
      source: "codex_image_generation",
      originalFilename: "ig_test.png",
      contentType: "image/png",
      toolCallId: "ig_test",
    });
    expect(result.reply.generatedAttachments?.[0]?.body.equals(Buffer.from("fake-png"))).toBe(true);
  });

  it("parses plain text result blocks for ordinary message replies", async () => {
    const svc = chatAssistantService({} as any);

    mockAdapter.execute.mockImplementationOnce(async () => ({
      summary: [
        "Preparing the final chat reply.",
        "RUDDER_RESULT_BEGIN",
        "OPENCODE_CHAT_OK",
        "RUDDER_RESULT_END",
      ].join("\n"),
      resultJson: null,
      timedOut: false,
      exitCode: 0,
      errorMessage: null,
    }));

    const result = await svc.streamChatAssistantReply({
      conversation: makeConversation(),
      messages: makeMessages(),
      contextLinks: [],
    });

    expect(result).toEqual({
      outcome: "completed",
      partialBody: "OPENCODE_CHAT_OK",
      replyingAgentId: "agent-1",
      reply: {
        kind: "message",
        body: "OPENCODE_CHAT_OK",
        structuredPayload: null,
        replyingAgentId: "agent-1",
      },
    });
    expect(mockChatAgentRuns.finalizeRun).toHaveBeenLastCalledWith(
      "chat-run-1",
      expect.objectContaining({
        status: "succeeded",
        resultJson: expect.objectContaining({
          outcome: "completed",
          kind: "message",
          body: "OPENCODE_CHAT_OK",
        }),
      }),
    );
  });

  it("does not promote progress text to a final reply when there is no terminal result to repair", async () => {
    const svc = chatAssistantService({} as any);

    mockAdapter.execute.mockImplementationOnce(async (ctx) => {
      await ctx.onLog(
        "stdout",
        `${JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "I am still working." },
        })}\n`,
      );
      return {
        summary: "",
        resultJson: null,
        timedOut: false,
        exitCode: 0,
        errorMessage: null,
      };
    });

    await expect(svc.streamChatAssistantReply({
      conversation: makeConversation(),
      messages: makeMessages(),
      contextLinks: [],
    })).rejects.toMatchObject({
      message: "Chat adapter completed without the required Rudder result sentinel",
      errorCode: "chat_result_missing_sentinel",
      userMessage: "The assistant reply could not be completed. Rudder saved the attempt for diagnostics; retry when ready.",
      partialBody: "",
      partialBodyUserVisible: false,
    });
    expect(mockAdapter.execute).toHaveBeenCalledTimes(1);
    expect(mockChatAgentRuns.finalizeRun).toHaveBeenLastCalledWith(
      "chat-run-1",
      expect.objectContaining({
        status: "failed",
        errorCode: "chat_result_missing_sentinel",
        resultJson: expect.objectContaining({
          recoverable: true,
          fallbackEnvelope: true,
        }),
      }),
    );
  });

  it("repairs a completed chat reply internally when the adapter exits successfully without the result sentinel", async () => {
    const browserSkill = { key: "bundled:rudder/browser", runtimeName: "browser", source: "/tmp/browser" };
    mockRunContextService.prepareRuntimeConfig.mockResolvedValueOnce({
      resolvedConfig: { model: "gpt-5.4" },
      runtimeConfig: {
        model: "gpt-5.4",
        rudderBrowserEnabled: true,
        rudderBrowserCapability: { instanceEligible: true, runtimeSkillEntries: [browserSkill] },
        rudderSkillSync: { desiredSkills: [browserSkill.key] },
        paperclipSkillSync: { desiredSkills: [browserSkill.key] },
        rudderRuntimeSkills: [browserSkill],
        paperclipRuntimeSkills: [browserSkill],
      },
      runtimeSkillEntries: [browserSkill],
      secretKeys: new Set(),
    });
    const svc = chatAssistantService({} as any);

    mockAdapter.execute
      .mockImplementationOnce(async (ctx) => {
        await ctx.onMeta?.({
          command: "codex",
          commandNotes: ["primary chat invocation"],
          context: { chatMode: true },
        });
        return {
        summary: "I checked the deployment logs. The failing webhook secret has been rotated and the retry is safe.",
        resultJson: null,
        timedOut: false,
        exitCode: 0,
        errorMessage: null,
        usage: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 5 },
        };
      })
      .mockImplementationOnce(async (ctx) => {
        await ctx.onMeta?.({
          command: "codex",
          commandNotes: ["repair invocation"],
          context: { chatMode: true },
        });
        return {
          summary: assistantSummary(ctx, "I checked the deployment logs. The failing webhook secret has been rotated and the retry is safe."),
          resultJson: null,
          timedOut: false,
          exitCode: 0,
          errorMessage: null,
          usage: { inputTokens: 3, cachedInputTokens: 1, outputTokens: 4 },
        };
      });
    const invocationMeta = vi.fn();

    await expect(svc.streamChatAssistantReply({
      conversation: makeConversation(),
      messages: makeMessages(),
      contextLinks: [],
      onInvocationMeta: invocationMeta,
    })).resolves.toEqual({
      outcome: "completed",
      partialBody: "I checked the deployment logs. The failing webhook secret has been rotated and the retry is safe.",
      replyingAgentId: "agent-1",
      reply: {
        kind: "message",
        body: "I checked the deployment logs. The failing webhook secret has been rotated and the retry is safe.",
        structuredPayload: null,
        replyingAgentId: "agent-1",
      },
    });
    expect(mockAdapter.execute).toHaveBeenCalledTimes(2);
    for (const [input] of mockAdapter.execute.mock.calls) {
      expect(input.config).not.toHaveProperty("rudderBrowserCapability");
      expect(input.agent.agentRuntimeConfig).not.toHaveProperty("rudderBrowserCapability");
      expect(input.config).toMatchObject({
        rudderBrowserEnabled: true,
        rudderSkillSync: { desiredSkills: [browserSkill.key] },
        paperclipSkillSync: { desiredSkills: [browserSkill.key] },
        rudderRuntimeSkills: [browserSkill],
        paperclipRuntimeSkills: [browserSkill],
      });
      expect(input.agent.agentRuntimeConfig).toEqual(input.config);
    }
    expect(mockAdapter.execute.mock.calls[1]?.[0]?.context?.chatPrompt).toContain("Rudder internal repair request:");
    expect(mockAdapter.execute.mock.calls[1]?.[0]?.context?.chatPrompt).toContain("Your previous chat turn ended without the required Rudder result sentinel.");
    expect(mockAdapter.execute.mock.calls[1]?.[0]?.context).toMatchObject({
      rudderChatResultRepair: true,
    });
    expect(invocationMeta).toHaveBeenCalledTimes(1);
    expect(mockChatAgentRuns.finalizeRun).toHaveBeenLastCalledWith(
      "chat-run-1",
      expect.objectContaining({
        status: "succeeded",
        resultJson: expect.objectContaining({
          outcome: "completed",
          kind: "message",
          sentinelRepairAttempted: true,
          sentinelRepairSucceeded: true,
          repairReason: "missing_result_sentinel",
        }),
        usageJson: expect.objectContaining({
          inputTokens: 13,
          cachedInputTokens: 3,
          outputTokens: 9,
          primary: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 5 },
          repair: { inputTokens: 3, cachedInputTokens: 1, outputTokens: 4 },
        }),
      }),
    );
  });

  it("redacts inline visual source before a missing-sentinel repair prompt is invoked or persisted", async () => {
    const svc = chatAssistantService({} as any);
    const rawPriorText = [
      "Visible answer",
      ":::rudder-inline-visual:v1",
      '<div id="widget">PRIVATE_REPAIR_FRAGMENT</div>',
      ":::rudder-inline-visual:end",
    ].join("\n");

    mockAdapter.execute
      .mockImplementationOnce(async () => ({
        summary: rawPriorText,
        resultJson: null,
        timedOut: false,
        exitCode: 0,
        errorMessage: null,
      }))
      .mockImplementationOnce(async (ctx) => {
        await ctx.onMeta?.({
          agentRuntimeType: "process",
          command: "repair-process",
          prompt: String(ctx.context.chatPrompt),
        });
        return {
          summary: assistantSummary(ctx, "Visible answer"),
          resultJson: null,
          timedOut: false,
          exitCode: 0,
          errorMessage: null,
        };
      });

    await expect(svc.streamChatAssistantReply({
      conversation: makeConversation(),
      messages: makeMessages(),
      contextLinks: [],
    })).resolves.toMatchObject({
      outcome: "completed",
      reply: { body: "Visible answer" },
    });

    const repairPrompt = String(mockAdapter.execute.mock.calls[1]?.[0]?.context?.chatPrompt);
    expect(repairPrompt).toContain("Previous response text:\nVisible answer");
    expect(repairPrompt).not.toContain("PRIVATE_REPAIR_FRAGMENT");
    expect(repairPrompt).not.toContain(":::rudder-inline-visual");
    const persistedInvoke = JSON.stringify(mockChatAgentRuns.appendAdapterInvoke.mock.calls);
    expect(persistedInvoke).not.toContain("PRIVATE_REPAIR_FRAGMENT");
    expect(persistedInvoke).not.toContain(":::rudder-inline-visual");
  });

  it("repairs a completed plain-text chat reply with a text result block", async () => {
    const svc = chatAssistantService({} as any);

    mockAdapter.execute
      .mockImplementationOnce(async () => ({
        summary: "OPENCODE_CHAT_OK",
        resultJson: null,
        timedOut: false,
        exitCode: 0,
        errorMessage: null,
      }))
      .mockImplementationOnce(async (ctx) => {
        expect(ctx.context?.chatPrompt).toContain("RUDDER_RESULT_BEGIN");
        return {
          summary: "RUDDER_RESULT_BEGIN\nOPENCODE_CHAT_OK\nRUDDER_RESULT_END",
          resultJson: null,
          timedOut: false,
          exitCode: 0,
          errorMessage: null,
        };
      });

    await expect(svc.streamChatAssistantReply({
      conversation: makeConversation(),
      messages: makeMessages(),
      contextLinks: [],
    })).resolves.toEqual({
      outcome: "completed",
      partialBody: "OPENCODE_CHAT_OK",
      replyingAgentId: "agent-1",
      reply: {
        kind: "message",
        body: "OPENCODE_CHAT_OK",
        structuredPayload: null,
        replyingAgentId: "agent-1",
      },
    });
    expect(mockChatAgentRuns.finalizeRun).toHaveBeenLastCalledWith(
      "chat-run-1",
      expect.objectContaining({
        status: "succeeded",
        resultJson: expect.objectContaining({
          sentinelRepairAttempted: true,
          sentinelRepairSucceeded: true,
          repairReason: "missing_result_sentinel",
        }),
      }),
    );
  });

  it("falls back to a plain final summary when an adapter ignores the message result block", async () => {
    const svc = chatAssistantService({} as any);

    mockAdapter.execute
      .mockImplementationOnce(async () => ({
        summary: "OPENCODE_CHAT_OK",
        resultJson: null,
        timedOut: false,
        exitCode: 0,
        errorMessage: null,
      }))
      .mockImplementationOnce(async () => ({
        summary: "",
        resultJson: null,
        timedOut: false,
        exitCode: 0,
        errorMessage: null,
      }));

    await expect(svc.streamChatAssistantReply({
      conversation: makeConversation(),
      messages: makeMessages(),
      contextLinks: [],
    })).resolves.toEqual({
      outcome: "completed",
      partialBody: "OPENCODE_CHAT_OK",
      replyingAgentId: "agent-1",
      reply: {
        kind: "message",
        body: "OPENCODE_CHAT_OK",
        structuredPayload: null,
        replyingAgentId: "agent-1",
      },
    });
    expect(mockAdapter.execute).toHaveBeenCalledTimes(2);
    expect(mockChatAgentRuns.finalizeRun).toHaveBeenLastCalledWith(
      "chat-run-1",
      expect.objectContaining({
        status: "succeeded",
        resultJson: expect.objectContaining({
          outcome: "completed",
          kind: "message",
          body: "OPENCODE_CHAT_OK",
          sentinelRepairAttempted: true,
          sentinelRepairSucceeded: false,
        }),
      }),
    );
  });

  it("classifies malformed result sentinel JSON as a recoverable failed chat result", async () => {
    const svc = chatAssistantService({} as any);

    mockAdapter.execute.mockImplementationOnce(async (ctx) => ({
      summary: `Draft reply\n${sentinelFromContext(ctx)}{"kind":"message","body":`,
      resultJson: null,
      timedOut: false,
      exitCode: 0,
      errorMessage: null,
    }));

    await expect(svc.streamChatAssistantReply({
      conversation: makeConversation(),
      messages: makeMessages(),
      contextLinks: [],
    })).rejects.toMatchObject({
      message: "Chat adapter emitted the Rudder result sentinel without a valid JSON payload",
      errorCode: "chat_result_malformed_json",
      userMessage: "The assistant returned an incomplete final reply. Rudder saved the attempt and transcript; retry when ready.",
      partialBody: "",
      partialBodyUserVisible: false,
    });
    expect(mockChatAgentRuns.finalizeRun).toHaveBeenLastCalledWith(
      "chat-run-1",
      expect.objectContaining({
        status: "failed",
        errorCode: "chat_result_malformed_json",
      }),
    );
  });

  it("does not expose progress transcript text as failed partial body", async () => {
    const svc = chatAssistantService({} as any);

    mockAdapter.execute.mockImplementationOnce(async (ctx) => {
      await ctx.onLog(
        "stdout",
        `${JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "I will inspect the issue first." },
        })}\n`,
      );
      await ctx.onLog(
        "stdout",
        `${JSON.stringify({
          type: "item.started",
          item: { type: "tool_use", id: "tool-1", name: "read_file", input: { path: "server/src/routes/chats.ts" } },
        })}\n`,
      );
      return {
        summary: "I will inspect the issue first.",
        resultJson: null,
        timedOut: false,
        exitCode: 1,
        errorMessage: "runtime process exited",
      };
    });

    await expect(svc.streamChatAssistantReply({
      conversation: makeConversation(),
      messages: makeMessages(),
      contextLinks: [],
    })).rejects.toMatchObject({
      message: "runtime process exited",
      errorCode: "chat_adapter_failed",
      userMessage: "The assistant runtime failed before finishing. Rudder saved the attempt for diagnostics; retry when ready.",
      partialBody: "",
      partialBodyUserVisible: false,
    });
    expect(mockChatAgentRuns.finalizeRun).toHaveBeenLastCalledWith(
      "chat-run-1",
      expect.objectContaining({
        status: "failed",
        errorCode: "chat_adapter_failed",
        resultJson: expect.objectContaining({
          recoverable: true,
          fallbackEnvelope: true,
        }),
      }),
    );
  });

  it("classifies adapter exits before model output as non-retryable runtime boot failures", async () => {
    const svc = chatAssistantService({} as any);

    mockAdapter.execute.mockImplementationOnce(async () => ({
      summary: "",
      resultJson: { stdout: "", stderr: "Killed: 9" },
      timedOut: false,
      exitCode: 137,
      signal: "SIGKILL",
      errorMessage: "Codex exited with code 137",
    }));

    await expect(svc.streamChatAssistantReply({
      conversation: makeConversation(),
      messages: makeMessages(),
      contextLinks: [],
    })).rejects.toMatchObject({
      message: "Codex exited with code 137",
      errorCode: "chat_runtime_boot_failed",
      userMessage: "The assistant runtime did not start successfully. Fix the runtime command or environment, then run again.",
      partialBody: "",
      partialBodyUserVisible: false,
      retryable: false,
      failurePhase: "runtime_boot",
      action: "repair_runtime",
    });
    expect(mockChatAgentRuns.finalizeRun).toHaveBeenLastCalledWith(
      "chat-run-1",
      expect.objectContaining({
        status: "failed",
        errorCode: "chat_runtime_boot_failed",
        resultJson: expect.objectContaining({
          recoverable: false,
          fallbackEnvelope: true,
          retryable: false,
          failurePhase: "runtime_boot",
          action: "repair_runtime",
        }),
      }),
    );
  });

  it("keeps a completed result body visible when the runtime fails after emitting the result envelope", async () => {
    const svc = chatAssistantService({} as any);

    mockAdapter.execute.mockImplementationOnce(async (ctx) => {
      const finalText = assistantSummary(ctx, "I have enough to answer.");
      return {
        summary: finalText,
        resultJson: null,
        timedOut: false,
        exitCode: 1,
        errorMessage: "post-processing failed",
      };
    });

    await expect(svc.streamChatAssistantReply({
      conversation: makeConversation(),
      messages: makeMessages(),
      contextLinks: [],
    })).rejects.toMatchObject({
      message: "post-processing failed",
      errorCode: "chat_adapter_failed",
      partialBody: "I have enough to answer.",
      partialBodyUserVisible: true,
      retryable: true,
      failurePhase: "model_generation",
      action: "retry",
    });
    expect(mockChatAgentRuns.finalizeRun).toHaveBeenLastCalledWith(
      "chat-run-1",
      expect.objectContaining({
        status: "failed",
        errorCode: "chat_adapter_failed",
        resultJson: expect.objectContaining({
          recoverable: true,
          retryable: true,
          failurePhase: "model_generation",
          action: "retry",
        }),
      }),
    );
  });

  it("classifies chat timeouts as recoverable failed chat results", async () => {
    const svc = chatAssistantService({} as any);

    mockAdapter.execute.mockImplementationOnce(async () => ({
      summary: "",
      resultJson: null,
      timedOut: true,
      exitCode: 0,
      errorMessage: null,
    }));

    await expect(svc.streamChatAssistantReply({
      conversation: makeConversation(),
      messages: makeMessages(),
      contextLinks: [],
    })).rejects.toMatchObject({
      message: "Chat request timed out",
      errorCode: "chat_timed_out",
      userMessage: "The assistant timed out before finishing. Rudder saved the partial attempt; retry when ready.",
      partialBody: "",
      partialBodyUserVisible: false,
    });
    expect(mockChatAgentRuns.finalizeRun).toHaveBeenLastCalledWith(
      "chat-run-1",
      expect.objectContaining({
        status: "timed_out",
        errorCode: "chat_timed_out",
      }),
    );
  });

  it("wraps runtime exceptions as recoverable failed chat results", async () => {
    const svc = chatAssistantService({} as any);

    mockAdapter.execute.mockImplementationOnce(async () => {
      throw new Error("runtime exploded");
    });

    await expect(svc.streamChatAssistantReply({
      conversation: makeConversation(),
      messages: makeMessages(),
      contextLinks: [],
    })).rejects.toMatchObject({
      message: "runtime exploded",
      errorCode: "chat_runtime_exception",
      userMessage: "The assistant reply could not be completed. Rudder saved this attempt for diagnostics; retry when ready.",
      partialBody: "",
      partialBodyUserVisible: false,
    });
    expect(mockChatAgentRuns.finalizeRun).toHaveBeenLastCalledWith(
      "chat-run-1",
      expect.objectContaining({
        status: "failed",
        errorCode: "chat_runtime_exception",
      }),
    );
  });

  it("returns a stopped partial reply when the runtime abort signal fires", async () => {
    const svc = chatAssistantService({} as any);
    const controller = new AbortController();
    const states: string[] = [];
    const assistantDeltas: string[] = [];
    const transcriptEntries: Array<{ kind: string; text?: string }> = [];
    const observedEntries: Array<{ kind: string; text?: string }> = [];

    mockAdapter.execute.mockImplementationOnce(async (ctx) => {
      await ctx.onLog(
        "stdout",
        `${JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "Partial streamed reply" },
        })}\n`,
      );
      controller.abort();
      await ctx.onLog(
        "stdout",
        `${JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: " Late assistant output" },
        })}\n`,
      );
      await ctx.onLog(
        "stdout",
        `${JSON.stringify({
          type: "result",
          result: "Late result output",
        })}\n`,
      );
      await ctx.onLog(
        "stdout",
        `${JSON.stringify({
          type: "item.completed",
          item: { type: "reasoning", text: "Late reasoning output" },
        })}\n`,
      );
      return {
        summary: "Partial streamed reply Late assistant output Late result output",
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
      onAssistantDelta: (delta) => {
        assistantDeltas.push(delta);
      },
      onTranscriptEntry: (entry) => {
        transcriptEntries.push(entry);
      },
      onObservedTranscriptEntry: (entry) => {
        observedEntries.push(entry);
      },
    });

    expect(result).toEqual({
      outcome: "stopped",
      partialBody: "Partial streamed reply",
      replyingAgentId: "agent-1",
    });
    expect(states).toEqual(["streaming", "stopped"]);
    expect(assistantDeltas.join("")).not.toContain("Late");
    expect(transcriptEntries).toEqual([
      expect.objectContaining({ kind: "assistant", text: "Partial streamed reply" }),
    ]);
    expect(observedEntries).toEqual([
      expect.objectContaining({ kind: "assistant", text: "Partial streamed reply" }),
    ]);
    expect(mockChatAgentRuns.appendTranscriptEntry).toHaveBeenCalledTimes(1);
  });

  it("does not expose reasoning as a stopped partial reply", async () => {
    const svc = chatAssistantService({} as any);
    const controller = new AbortController();
    const assistantDeltas: string[] = [];

    mockAdapter.execute.mockImplementationOnce(async (ctx) => {
      await ctx.onLog(
        "stdout",
        `${JSON.stringify({
          type: "item.completed",
          item: { type: "reasoning", text: "Internal reasoning should stay out of chat." },
        })}\n`,
      );
      controller.abort();
      return {
        summary: "Internal reasoning should stay out of chat.",
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
      onAssistantDelta: (delta) => {
        assistantDeltas.push(delta);
      },
    });

    expect(result).toEqual({
      outcome: "stopped",
      partialBody: "",
      replyingAgentId: "agent-1",
    });
    expect(assistantDeltas.join("")).not.toContain("Internal reasoning");
  });
});
