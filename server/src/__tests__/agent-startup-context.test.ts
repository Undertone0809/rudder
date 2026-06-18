import {
  agents,
  applyPendingMigrations,
  chatContextLinks,
  chatConversations,
  chatMessages,
  createDb,
  ensurePostgresDatabase,
  issues,
  organizations,
} from "@rudderhq/db";
import { deriveOrganizationUrlKey } from "@rudderhq/shared";
import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentStartupContextService,
  buildAgentStartupContextPrompt,
  DEFAULT_AGENT_STARTUP_CONTEXT_LIMITS,
} from "../services/agent-startup-context.js";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

async function getEmbeddedPostgresCtor(): Promise<EmbeddedPostgresCtor> {
  const mod = await import("embedded-postgres");
  return mod.default as EmbeddedPostgresCtor;
}

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate test port")));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

async function startTempDatabase() {
  const externalConnectionString = process.env.RUDDER_AGENT_STARTUP_CONTEXT_TEST_DATABASE_URL?.trim();
  if (externalConnectionString) {
    await applyPendingMigrations(externalConnectionString);
    return { connectionString: externalConnectionString, dataDir: "", instance: null };
  }

  const dataDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "rudder-agent-startup-context-"));
  const port = await getAvailablePort();
  const EmbeddedPostgres = await getEmbeddedPostgresCtor();
  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "rudder",
    password: "rudder",
    port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: () => {},
    onError: () => {},
  });
  await instance.initialise();
  await instance.start();

  const adminConnectionString = `postgres://rudder:rudder@127.0.0.1:${port}/postgres`;
  await ensurePostgresDatabase(adminConnectionString, "rudder");
  const connectionString = `postgres://rudder:rudder@127.0.0.1:${port}/rudder`;
  await applyPendingMigrations(connectionString);
  return { connectionString, dataDir, instance };
}

describe("agent startup context prompt", () => {
  it("renders daily memory, recent issues, recent chats, and metadata in the compact startup format", () => {
    const prompt = buildAgentStartupContextPrompt({
      todayMemory: {
        dateKey: "2026-06-19",
        relativePath: "memory/2026-06-19.md",
        content: "- Morning calibration\n- Keep context compact",
        existed: true,
        created: false,
      },
      yesterdayMemory: {
        dateKey: "2026-06-18",
        relativePath: "memory/2026-06-18.md",
        content: "- Launch work clustered around Rudder\n- Avoid broad context dumps",
        existed: true,
        created: false,
      },
      recentIssues: [
        {
          id: "issue-1",
          identifier: "RD-421",
          status: "in_review",
          role: "assignee",
          title: "Agent startup memory context",
          snippet: "Define bounded startup context for agent runs without full transcript dumps.",
        },
        {
          id: "issue-2",
          identifier: null,
          status: "done",
          role: "reviewer",
          title: "Messenger title defaults",
          snippet: "Fix generated chat title behavior.",
        },
      ],
      recentChats: [
        {
          id: "chat_01JY9M2V8Q6Z",
          activityAt: new Date("2026-06-19T00:33:00.000Z"),
          title: "Agent run startup memory",
          snippet: "我现在想的是所有的 agent run，把每次启动的时候默认装载今天和昨天的 memory md 进来",
        },
      ],
      metrics: {
        version: "agent-startup-context/v1",
        totalChars: 0,
        limitChars: DEFAULT_AGENT_STARTUP_CONTEXT_LIMITS.totalChars,
        omittedIssues: 6,
        omittedChats: 7,
      },
    });

    expect(prompt).toContain("## Recent Rudder Context");
    expect(prompt).toContain("#### today memory/2026-06-19.md");
    expect(prompt).toContain("- Morning calibration");
    expect(prompt).toContain("#### yesterday memory/2026-06-18.md");
    expect(prompt).toContain("- Launch work clustered around Rudder");
    expect(prompt).toContain("#### recent issues");
    expect(prompt).toContain(
      "1. `RD-421` |||| `in_review` |||| assignee |||| Agent startup memory context |||| Define bounded startup context for agent runs without full transcript dumps.",
    );
    expect(prompt).toContain(
      "2. `issue-2` |||| `done` |||| reviewer |||| Messenger title defaults |||| Fix generated chat title behavior.",
    );
    expect(prompt).toContain("#### recent chats");
    expect(prompt).toContain(
      "1. `chat_01JY9M2V8Q6Z` |||| 2026-06-19T00:33:00.000Z |||| Agent run startup memory |||| 我现在想的是所有的 agent run",
    );
    expect(prompt).toContain("#### startup context metadata");
    expect(prompt).toContain("version |||| `agent-startup-context/v1`");
    expect(prompt).toContain("omitted |||| 6 older issues |||| 7 older chats");
    expect(prompt).not.toContain("recent runs");
    expect(prompt).not.toContain("Read today's and yesterday's memory files");
  });

  it("clips long memory and snippets without exceeding the startup context cap", () => {
    const prompt = buildAgentStartupContextPrompt({
      todayMemory: {
        dateKey: "2026-06-19",
        relativePath: "memory/2026-06-19.md",
        content: "a".repeat(500),
        existed: true,
        created: false,
      },
      yesterdayMemory: {
        dateKey: "2026-06-18",
        relativePath: "memory/2026-06-18.md",
        content: "b".repeat(500),
        existed: true,
        created: false,
      },
      recentIssues: [{
        id: "issue-1",
        identifier: "RD-421",
        status: "todo",
        role: "assignee",
        title: "Long issue",
        snippet: "c".repeat(500),
      }],
      recentChats: [{
        id: "chat-1",
        activityAt: new Date("2026-06-19T00:33:00.000Z"),
        title: "Long chat",
        snippet: "d".repeat(500),
      }],
      metrics: {
        version: "agent-startup-context/v1",
        totalChars: 0,
        limitChars: 420,
        omittedIssues: 0,
        omittedChats: 0,
      },
    }, {
      totalChars: 420,
      memoryFileChars: 80,
      issueSnippetChars: 60,
      chatSnippetChars: 60,
    });

    expect(prompt.length).toBeLessThanOrEqual(420);
    expect(prompt).toContain("...");
    expect(prompt).toContain("limits ||||");
  });
});

describe("agent startup context service", () => {
  let db!: ReturnType<typeof createDb>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";
  let memoryDir = "";

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 20_000);

  afterEach(async () => {
    await db.delete(chatMessages);
    await db.delete(chatContextLinks);
    await db.delete(chatConversations);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(organizations);
    if (memoryDir) await fs.rm(memoryDir, { recursive: true, force: true });
    memoryDir = "";
  });

  afterAll(async () => {
    await instance?.stop();
    if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
  });

  async function seedOrgAgent(name: string) {
    const orgId = randomUUID();
    const agentId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name,
      urlKey: deriveOrganizationUrlKey(`${name}-${orgId.slice(0, 6)}`),
      issuePrefix: name.slice(0, 3).toUpperCase(),
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: `${name} Agent`,
      role: "engineer",
      status: "idle",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { orgId, agentId };
  }

  it("dedupes multi-linked chats, excludes the current chat scene, and keeps org scope", async () => {
    const primary = await seedOrgAgent("Primary");
    const other = await seedOrgAgent("Other");
    const issueId = randomUUID();
    const currentChatId = randomUUID();
    const recentChatId = randomUUID();
    const otherOrgChatId = randomUUID();
    const now = new Date("2026-06-19T03:00:00.000Z");
    memoryDir = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-startup-memory-"));

    await db.insert(issues).values({
      id: issueId,
      orgId: primary.orgId,
      title: "Scoped startup issue",
      description: "Only the primary org should see this issue.",
      status: "in_progress",
      assigneeAgentId: primary.agentId,
      identifier: "RD-500",
    });
    await db.insert(chatConversations).values([
      {
        id: currentChatId,
        orgId: primary.orgId,
        title: "Current chat",
        summary: "current chat body must not be duplicated",
        preferredAgentId: primary.agentId,
        lastMessageAt: new Date("2026-06-19T02:00:00.000Z"),
        issueCreationMode: "manual_approval",
        planMode: false,
      },
      {
        id: recentChatId,
        orgId: primary.orgId,
        title: "Recent linked chat",
        summary: "recent linked chat body",
        preferredAgentId: primary.agentId,
        lastMessageAt: new Date("2026-06-19T01:00:00.000Z"),
        issueCreationMode: "manual_approval",
        planMode: false,
      },
      {
        id: otherOrgChatId,
        orgId: other.orgId,
        title: "Other org chat",
        summary: "other org body",
        preferredAgentId: other.agentId,
        lastMessageAt: new Date("2026-06-19T00:30:00.000Z"),
        issueCreationMode: "manual_approval",
        planMode: false,
      },
    ]);
    await db.insert(chatContextLinks).values([
      { orgId: primary.orgId, conversationId: recentChatId, entityType: "agent", entityId: primary.agentId },
      { orgId: primary.orgId, conversationId: recentChatId, entityType: "issue", entityId: issueId },
      { orgId: other.orgId, conversationId: otherOrgChatId, entityType: "agent", entityId: other.agentId },
    ]);
    await db.insert(chatMessages).values([
      {
        id: randomUUID(),
        orgId: primary.orgId,
        conversationId: currentChatId,
        role: "user",
        kind: "message",
        status: "completed",
        body: "current chat body must not be duplicated",
      },
      {
        id: randomUUID(),
        orgId: primary.orgId,
        conversationId: recentChatId,
        role: "user",
        kind: "message",
        status: "completed",
        body: "recent linked chat body",
      },
      {
        id: randomUUID(),
        orgId: other.orgId,
        conversationId: otherOrgChatId,
        role: "user",
        kind: "message",
        status: "completed",
        body: "other org body",
      },
    ]);

    const bundle = await agentStartupContextService(db).buildForRun({
      orgId: primary.orgId,
      agentId: primary.agentId,
      agentHome: path.dirname(memoryDir),
      memoryDir,
      scene: "chat",
      issueId,
      chatConversationId: currentChatId,
      now,
    });

    expect(bundle.markdown).toContain("`RD-500`");
    expect(bundle.markdown).toContain(`1. \`${recentChatId}\` ||||`);
    expect(bundle.markdown).toContain("recent linked chat body");
    expect(bundle.markdown).not.toContain(currentChatId);
    expect(bundle.markdown).not.toContain("current chat body must not be duplicated");
    expect(bundle.markdown).not.toContain(otherOrgChatId);
    expect(bundle.markdown).not.toContain("other org body");
    expect(bundle.metrics.recentChatsCount).toBe(1);
  });
});
