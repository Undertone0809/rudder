import { Readable } from "node:stream";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatAttachment, ChatContextLink, ChatConversation, ChatMessage } from "@rudderhq/shared";

const mockAdapter = vi.hoisted(() => ({
  type: "codex_local",
  supportsLocalAgentJwt: true,
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

const mockRunContextService = vi.hoisted(() => ({
  prepareRuntimeConfig: vi.fn(),
  resolveWorkspaceForRun: vi.fn(),
  buildSceneContext: vi.fn(),
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

const { chatAssistantService } = await import("../services/chat-assistant.js");
const { validateAssistantResult } = await import("../services/chat-assistant.helpers.js");

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
    mockAgentService.getById.mockResolvedValue({
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
    expect(mockAgentService.getById).not.toHaveBeenCalled();
  });

  it("refuses to generate a reply without a preferred agent", async () => {
    const svc = chatAssistantService({} as any);

    await expect(svc.generateChatAssistantReply({
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
    })).rejects.toThrow("Choose a chat agent before sending messages.");
    expect(mockAgentService.getById).not.toHaveBeenCalled();
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
    mockAgentService.getById.mockResolvedValueOnce({
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

  it("rejects ask_user final results without a valid requestUserInput payload", async () => {
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
    })).rejects.toThrow("ask_user assistant responses require structuredPayload.requestUserInput");
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

  it("recovers a plain chat message when the adapter omits the required result sentinel", async () => {
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
        summary: "I am still working.",
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
    });

    expect(result.outcome).toBe("completed");
    if (result.outcome !== "completed") throw new Error("expected completed");
    expect(result.reply).toMatchObject({
      kind: "message",
      body: "I am still working.",
      structuredPayload: null,
    });
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
      replyingAgentId: "agent-1",
    });
    expect(states).toEqual(["streaming", "stopped"]);
  });
});
