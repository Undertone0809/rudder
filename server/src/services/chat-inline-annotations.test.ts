import {
  agents,
  applyPendingMigrations,
  assets,
  chatAttachments,
  chatConversations,
  chatGenerationEvents,
  chatGenerations,
  chatMessages,
  createDb,
  ensurePostgresDatabase,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  organizationSkills,
  organizations,
} from "@rudderhq/db";
import {
  buildIssueMentionHref,
  createMarkdownSourceBoundaryMap,
  type ChatInlineAnnotationInput,
} from "@rudderhq/shared";
import { eq } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ensureOrganizationWorkspaceLayout,
  resolveOrganizationWorkspaceRoot,
} from "../home-paths.js";
import {
  bindPreparedChatInlineAnnotationFiles,
  chatInlineAnnotationService,
} from "./chat-inline-annotations.js";
import { createChatAnnotationMessagePersistence } from "./chats.annotation-persistence.js";
import { chatService } from "./chats.js";

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

async function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate test port")));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function startTempDatabase() {
  const externalUrl = process.env.RUDDER_CHAT_ANNOTATION_TEST_DATABASE_URL?.trim();
  if (externalUrl) {
    await applyPendingMigrations(externalUrl);
    return { connectionString: externalUrl, dataDir: "", instance: null };
  }

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-chat-inline-annotations-"));
  const port = await getAvailablePort();
  const mod = await import("embedded-postgres");
  const EmbeddedPostgres = mod.default as EmbeddedPostgresCtor;
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
  const adminUrl = `postgres://rudder:rudder@127.0.0.1:${port}/postgres`;
  await ensurePostgresDatabase(adminUrl, "rudder");
  const connectionString = `postgres://rudder:rudder@127.0.0.1:${port}/rudder`;
  await applyPendingMigrations(connectionString);
  return { connectionString, dataDir, instance };
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

describe("chatInlineAnnotationService", () => {
  let db!: ReturnType<typeof createDb>;
  let service!: ReturnType<typeof chatInlineAnnotationService>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";
  let originalWorkspaceHome: string | undefined;

  beforeAll(async () => {
    const started = await startTempDatabase();
    originalWorkspaceHome = process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME;
    process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME = path.join(
      started.dataDir || os.tmpdir(),
      `rudder-annotation-workspaces-${randomUUID()}`,
    );
    db = createDb(started.connectionString);
    service = chatInlineAnnotationService(db);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 30_000);

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(chatGenerationEvents);
    await db.delete(chatGenerations);
    await db.delete(chatAttachments);
    await db.delete(assets);
    await db.delete(chatMessages);
    await db.delete(chatConversations);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(organizationSkills);
    await db.delete(organizations);
  });

  afterAll(async () => {
    await instance?.stop();
    if (process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME) {
      fs.rmSync(process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME, {
        recursive: true,
        force: true,
      });
      if (originalWorkspaceHome === undefined) {
        delete process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME;
      } else {
        process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME = originalWorkspaceHome;
      }
    }
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function seedSource(input: {
    body?: string;
    role?: "user" | "assistant";
    status?: "streaming" | "completed" | "stopped" | "failed" | "interrupted";
    supersededAt?: Date | null;
  } = {}) {
    const orgId = randomUUID();
    const conversationId = randomUUID();
    const sourceMessageId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name: "Annotation test",
      urlKey: `annotation-${orgId}`,
      issuePrefix: `A${orgId.replaceAll("-", "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Annotation source",
    });
    await db.insert(chatMessages).values({
      id: sourceMessageId,
      orgId,
      conversationId,
      role: input.role ?? "assistant",
      kind: "message",
      status: input.status ?? "completed",
      body: input.body ?? "Read [the docs](https://example.test) and `run tests` before shipping.",
      supersededAt: input.supersededAt ?? null,
    });
    return { orgId, conversationId, sourceMessageId };
  }

  function assistantAnnotation(
    source: Awaited<ReturnType<typeof seedSource>>,
    body: string,
    overrides: Partial<Extract<ChatInlineAnnotationInput, { surface: "assistant_body" }>> = {},
  ): ChatInlineAnnotationInput {
    const start = body.indexOf("the docs");
    const end = body.indexOf("run tests") + "run tests".length;
    return {
      id: randomUUID(),
      surface: "assistant_body",
      selectedText: "the docs and run tests",
      comment: "Explain why this sequence matters.",
      sourceConversationId: source.conversationId,
      sourceMessageId: source.sourceMessageId,
      sourceHash: sha256(body),
      start,
      end,
      prefix: body.slice(Math.max(0, start - 5), start),
      suffix: body.slice(end, end + 16),
      attachmentIds: [],
      attachmentFileIndexes: [0],
      ...overrides,
    } as ChatInlineAnnotationInput;
  }

  it("accepts exact saved workspace-file and local-file annotations", async () => {
    const source = await seedSource();
    await ensureOrganizationWorkspaceLayout(source.orgId);
    const workspaceRoot = resolveOrganizationWorkspaceRoot(source.orgId);
    const workspaceContent = "alpha beta gamma";
    fs.mkdirSync(path.join(workspaceRoot, "notes"), { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, "notes", "example.txt"), workspaceContent);
    const workspaceStart = workspaceContent.indexOf("beta");

    await expect(service.prepare({
      orgId: source.orgId,
      conversationId: source.conversationId,
      uploadedFileCount: 0,
      annotations: [{
        id: randomUUID(),
        surface: "workspace_file",
        selectedText: "beta",
        comment: "Use this value.",
        sourceConversationId: source.conversationId,
        sourceFilePath: "notes/example.txt",
        sourceLibraryEntryId: null,
        sourceRenderMode: "text",
        sourceHash: sha256(workspaceContent),
        start: workspaceStart,
        end: workspaceStart + "beta".length,
        prefix: "alpha ",
        suffix: " gamma",
        attachmentIds: [],
      }, {
        id: randomUUID(),
        surface: "local_file",
        selectedText: "local",
        comment: null,
        sourceConversationId: source.conversationId,
        sourceFilePath: path.join(os.tmpdir(), "local-example.txt"),
        sourceRenderMode: "text",
        sourceHash: sha256("local source"),
        start: 0,
        end: "local".length,
        prefix: "",
        suffix: " source",
        attachmentIds: [],
      }],
    })).resolves.toMatchObject({
      annotations: [
        expect.objectContaining({ surface: "workspace_file", selectedText: "beta" }),
        expect.objectContaining({ surface: "local_file", selectedText: "local" }),
      ],
    });
  });

  it("rejects protected workspace paths and unrelated file-annotation conversations", async () => {
    const source = await seedSource();

    await expect(service.prepare({
      orgId: source.orgId,
      conversationId: source.conversationId,
      uploadedFileCount: 0,
      annotations: [{
        id: randomUUID(),
        surface: "workspace_file",
        selectedText: "secret",
        sourceConversationId: source.conversationId,
        sourceFilePath: "skills/private.md",
        sourceLibraryEntryId: null,
        sourceRenderMode: "text",
        sourceHash: sha256("secret"),
        start: 0,
        end: 6,
        prefix: "",
        suffix: "",
        attachmentIds: [],
      }],
    })).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("Protected workspace"),
    });

    await expect(service.prepare({
      orgId: source.orgId,
      conversationId: source.conversationId,
      uploadedFileCount: 0,
      annotations: [{
        id: randomUUID(),
        surface: "local_file",
        selectedText: "local",
        sourceConversationId: randomUUID(),
        sourceFilePath: path.join(os.tmpdir(), "local-example.txt"),
        sourceRenderMode: "text",
        sourceHash: sha256("local"),
        start: 0,
        end: 5,
        prefix: "",
        suffix: "",
        attachmentIds: [],
      }],
    })).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("target conversation"),
    });
  });

  async function seedProcessEvidence(input: {
    source: Awaited<ReturnType<typeof seedSource>>;
    text?: string;
    entryOverrides?: Record<string, unknown>;
    projectToVisibleMessage?: boolean;
  }) {
    const generationId = randomUUID();
    const text = input.text ?? "Inspect";
    const kind = input.entryOverrides?.kind === "assistant" ? "assistant" : "thinking";
    const ts = "2026-07-23T10:00:00.000Z";
    await db.insert(chatGenerations).values({
      id: generationId,
      orgId: input.source.orgId,
      conversationId: input.source.conversationId,
      status: "completed",
      completedAt: new Date(),
    });
    await db.insert(chatGenerationEvents).values({
      orgId: input.source.orgId,
      generationId,
      generationSeq: 1,
      attemptEpoch: 1,
      eventKind: "transcript",
      payload: {
        entry: {
          kind,
          ts,
          text,
          delta: true,
          ...input.entryOverrides,
        },
      },
      assistantMessageId: input.source.sourceMessageId,
    });
    if (input.projectToVisibleMessage !== false) {
      await db.update(chatMessages).set({
        structuredPayload: {
          __chatTranscript: [{
            kind,
            ts,
            text,
            delta: true,
            generationId,
            generationSeqStart: 1,
            generationSeqEnd: 1,
          }],
        },
      }).where(eq(chatMessages.id, input.source.sourceMessageId));
    }
    return { generationId, text };
  }

  async function seedAgentRunEvidence(source: Awaited<ReturnType<typeof seedSource>>) {
    const agentId = randomUUID();
    const runId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      orgId: source.orgId,
      name: "Transcript annotation agent",
      role: "engineer",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      orgId: source.orgId,
      agentId,
      status: "succeeded",
      finishedAt: new Date(),
    });
    const eventRows = await db.insert(heartbeatRunEvents).values([
      {
        orgId: source.orgId,
        runId,
        agentId,
        seq: 1,
        eventType: "transcript.entry",
        payload: {
          kind: "assistant",
          ts: "2026-08-03T08:00:00.000Z",
          text: "Review ",
          delta: true,
        },
      },
      {
        orgId: source.orgId,
        runId,
        agentId,
        seq: 2,
        eventType: "transcript.entry",
        payload: {
          kind: "assistant",
          ts: "2026-08-03T08:00:01.000Z",
          text: "the docs before shipping.",
          delta: true,
        },
      },
    ]).returning();
    return { agentId, runId, events: eventRows };
  }

  it("validates terminal Agent Run transcript text provenance and source identity", async () => {
    const source = await seedSource();
    const run = await seedAgentRunEvidence(source);
    const [firstEvent, secondEvent] = run.events;
    const annotation: ChatInlineAnnotationInput = {
      id: randomUUID(),
      surface: "agent_run_transcript",
      selectedText: "the docs before shipping.",
      comment: "Keep the evidence attached.",
      sourceRunId: run.runId,
      sourceAgentId: run.agentId,
      anchorKind: "text",
      sourceEntryId: firstEvent!.id,
      sourceMemberIds: [firstEvent!.id, secondEvent!.id],
      sourceHash: sha256("Review the docs before shipping."),
      attachmentIds: [],
    };

    await expect(service.prepare({
      orgId: source.orgId,
      conversationId: source.conversationId,
      uploadedFileCount: 0,
      annotations: [annotation],
    })).resolves.toMatchObject({
      annotations: [expect.objectContaining({
        surface: "agent_run_transcript",
        sourceRunId: run.runId,
        sourceAgentId: run.agentId,
      })],
    });

    await expect(service.prepare({
      orgId: source.orgId,
      conversationId: source.conversationId,
      uploadedFileCount: 0,
      annotations: [{
        ...annotation,
        id: randomUUID(),
        sourceAgentId: randomUUID(),
      }] as ChatInlineAnnotationInput[],
    })).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("source run"),
    });
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, run.runId));
    await expect(service.prepare({
      orgId: source.orgId,
      conversationId: source.conversationId,
      uploadedFileCount: 0,
      annotations: [{ ...annotation, id: randomUUID() }],
    })).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("terminal"),
    });
  });

  it("rejects a transition whose source entry is hidden even when another member is visible", async () => {
    const source = await seedSource();
    const run = await seedAgentRunEvidence(source);
    const hiddenEvent = (await db.insert(heartbeatRunEvents).values({
      orgId: source.orgId,
      runId: run.runId,
      agentId: run.agentId,
      seq: 3,
      eventType: "adapter.invoke",
      payload: { hidden: true, text: "private invocation" },
    }).returning())[0]!;
    const annotation: ChatInlineAnnotationInput = {
      id: randomUUID(),
      surface: "agent_run_transcript",
      selectedText: "private invocation",
      comment: null,
      sourceRunId: run.runId,
      sourceAgentId: run.agentId,
      anchorKind: "transition",
      sourceEntryId: hiddenEvent.id,
      sourceMemberIds: [run.events[0]!.id],
      sourceHash: sha256("private invocation"),
      attachmentIds: [],
    };

    await expect(service.prepare({
      orgId: source.orgId,
      conversationId: source.conversationId,
      uploadedFileCount: 0,
      annotations: [annotation],
    })).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("source entry must be visible"),
    });
  });

  it("validates Markdown source anchors without equating rendered selected text to the raw slice", async () => {
    const body = "Read [the docs](https://example.test) and `run tests` before shipping.";
    const source = await seedSource({ body });
    const annotation = assistantAnnotation(source, body);

    const prepared = await service.prepare({
      orgId: source.orgId,
      conversationId: source.conversationId,
      annotations: [annotation],
      uploadedFileCount: 1,
    });
    const canonical = bindPreparedChatInlineAnnotationFiles(
      prepared,
      prepared.annotations,
      [randomUUID()],
    );

    expect(canonical).toEqual([expect.objectContaining({
      id: annotation.id,
      selectedText: "the docs and run tests",
      sourceHash: sha256(body),
      attachmentIds: [expect.any(String)],
    })]);
    expect(canonical[0]).not.toHaveProperty("attachmentFileIndexes");
  });

  it("signals committed annotation uploads before post-transaction message hydration", async () => {
    const body = "Read [the docs](https://example.test) and `run tests` before shipping.";
    const source = await seedSource({ body });
    const prepared = await service.prepare({
      orgId: source.orgId,
      conversationId: source.conversationId,
      annotations: [assistantAnnotation(source, body)],
      uploadedFileCount: 1,
    });
    const onTransactionCommitted = vi.fn();
    const persist = createChatAnnotationMessagePersistence(
      db,
      async () => null,
    );

    await expect(persist(
      source.conversationId,
      source.orgId,
      "",
      null,
      {
        structuredPayload: { inlineAnnotations: prepared.annotations },
        structuredPayloadProvided: true,
        attachments: [{
          provider: "local_disk",
          objectKey: "chats/annotation/committed-before-hydration.txt",
          contentType: "text/plain",
          byteSize: 4,
          sha256: "a".repeat(64),
          originalFilename: "context.txt",
          createdByAgentId: null,
          createdByUserId: "user-1",
        }],
        attachmentFileIndexesByAnnotationId:
          prepared.attachmentFileIndexesByAnnotationId,
        onTransactionCommitted,
      },
    )).rejects.toThrow("Failed to hydrate created chat message");

    expect(onTransactionCommitted).toHaveBeenCalledTimes(1);
    expect(await db.select().from(assets)).toEqual([
      expect.objectContaining({
        objectKey: "chats/annotation/committed-before-hydration.txt",
      }),
    ]);
    expect(await db.select().from(chatAttachments)).toHaveLength(1);
    expect(
      (await db.select().from(chatMessages))
        .filter((message) => message.role === "user"),
    ).toHaveLength(1);
    const [committedUserMessage] = (await db.select().from(chatMessages))
      .filter((message) => message.role === "user");
    expect(onTransactionCommitted).toHaveBeenCalledWith(committedUserMessage?.id);
  });

  it("converges concurrent user-message retries on one client mutation", async () => {
    const source = await seedSource({ body: "Assistant source" });
    const chats = chatService(db);
    const persist = createChatAnnotationMessagePersistence(db, chats.getMessage);
    const clientMutationId = `send:${randomUUID()}`;
    const replayed = vi.fn();

    const [first, retry] = await Promise.all([
      persist(source.conversationId, source.orgId, "Send exactly once", null, {
        clientMutationId,
        onIdempotentReplay: replayed,
      }),
      persist(source.conversationId, source.orgId, "Send exactly once", null, {
        clientMutationId,
        onIdempotentReplay: replayed,
      }),
    ]);

    expect(retry.id).toBe(first.id);
    expect(first).not.toHaveProperty("clientMutationId");
    expect(replayed).toHaveBeenCalledTimes(1);
    expect(await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.clientMutationId, clientMutationId)))
      .toHaveLength(1);
    await expect(persist(
      source.conversationId,
      source.orgId,
      "Different content",
      null,
      { clientMutationId },
    )).rejects.toMatchObject({ status: 409 });
  });

  it("accepts rendered assistant selections across links, inline code, CJK, entities, whitespace, and blocks", async () => {
    const body = [
      "## 说明",
      "",
      "阅读 [中文文档](https://example.test/docs) 与 `npm test` &amp; verify.",
      "",
      "Second block.",
    ].join("\n");
    const source = await seedSource({ body });
    const start = body.indexOf("中文文档");
    const end = body.indexOf("Second block.") + "Second block.".length;

    await expect(service.prepare({
      orgId: source.orgId,
      conversationId: source.conversationId,
      uploadedFileCount: 0,
      annotations: [{
        id: randomUUID(),
        surface: "assistant_body",
        selectedText: "中文文档 与 npm test & verify.\nSecond block.",
        comment: null,
        sourceConversationId: source.conversationId,
        sourceMessageId: source.sourceMessageId,
        sourceHash: sha256(body),
        start,
        end,
        prefix: body.slice(Math.max(0, start - 12), start),
        suffix: body.slice(end, end + 12),
        attachmentIds: [],
      }],
    })).resolves.toMatchObject({
      annotations: [expect.objectContaining({
        selectedText: "中文文档 与 npm test & verify.\nSecond block.",
      })],
    });
  });

  it("accepts only current resolved issue and skill labels for anchored Markdown links", async () => {
    const source = await seedSource({ body: "placeholder" });
    const issueId = randomUUID();
    const skillId = randomUUID();
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      orgId: source.orgId,
      name: "Annotation agent",
      role: "engineer",
    });
    await db.insert(issues).values({
      id: issueId,
      orgId: source.orgId,
      title: "Current issue title",
      identifier: "RUD-42",
      createdByAgentId: agentId,
    });
    await db.insert(organizationSkills).values({
      id: skillId,
      orgId: source.orgId,
      key: "org:current-skill",
      slug: "current-skill",
      name: "Current skill",
      markdown: "# Current skill",
    });
    const issueLink = `[stale issue](issue://${issueId})`;
    const skillLink = `[stale-skill](skill://org/${skillId}?ref=stale-skill)`;
    const body = `Review ${issueLink} with ${skillLink} before shipping.`;
    await db.update(chatMessages)
      .set({ body })
      .where(eq(chatMessages.id, source.sourceMessageId));
    const start = body.indexOf(issueLink);
    const end = body.indexOf(skillLink) + skillLink.length;
    const annotation = assistantAnnotation(source, body, {
      selectedText: "RUD-42 Current issue title with current-skill",
      start,
      end,
      prefix: body.slice(Math.max(0, start - 12), start),
      suffix: body.slice(end, end + 16),
      attachmentFileIndexes: [],
    });

    await expect(service.prepare({
      orgId: source.orgId,
      conversationId: source.conversationId,
      uploadedFileCount: 0,
      annotations: [annotation],
    })).resolves.toMatchObject({
      annotations: [expect.objectContaining({
        selectedText: "RUD-42 Current issue title with current-skill",
      })],
    });

    await expect(service.prepare({
      orgId: source.orgId,
      conversationId: source.conversationId,
      uploadedFileCount: 0,
      annotations: [{
        ...annotation,
        id: randomUUID(),
        selectedText: "stale issue with stale-skill",
      }] as ChatInlineAnnotationInput[],
    })).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("selected text"),
      details: {
        code: "chat_annotation_selection_mismatch",
        phase: "annotation_validation",
      },
    });

    await expect(service.prepare({
      orgId: source.orgId,
      conversationId: source.conversationId,
      uploadedFileCount: 0,
      annotations: [{
        ...annotation,
        id: randomUUID(),
        selectedText: "RUD-42 Current issue title with fabricated-skill",
      }],
    })).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("selected text"),
    });

    const issueLabel = "RUD-42 Current issue title";
    const skillLabel = "current-skill";
    const partialStart = start
      + createMarkdownSourceBoundaryMap(issueLink, issueLabel)
        .renderedBoundaryToRaw["RUD-42 ".length]!;
    const skillStart = body.indexOf(skillLink);
    const partialEnd = skillStart
      + createMarkdownSourceBoundaryMap(skillLink, skillLabel)
        .renderedBoundaryToRaw["current".length]!;
    await expect(service.prepare({
      orgId: source.orgId,
      conversationId: source.conversationId,
      uploadedFileCount: 0,
      annotations: [{
        ...annotation,
        id: randomUUID(),
        selectedText: "Current issue title with current",
        start: partialStart,
        end: partialEnd,
        prefix: body.slice(Math.max(0, partialStart - 160), partialStart),
        suffix: body.slice(partialEnd, partialEnd + 160),
      }] as ChatInlineAnnotationInput[],
    })).resolves.toMatchObject({
      annotations: [expect.objectContaining({
        selectedText: "Current issue title with current",
      })],
    });

    await expect(service.prepare({
      orgId: source.orgId,
      conversationId: source.conversationId,
      uploadedFileCount: 0,
      annotations: [assistantAnnotation(source, body, {
        id: randomUUID(),
        selectedText: "Review ",
        start: 0,
        end: start,
        prefix: "",
        suffix: body.slice(start, start + 160),
        attachmentFileIndexes: [],
      })],
    })).resolves.toMatchObject({
      annotations: [expect.objectContaining({
        selectedText: "Review ",
      })],
    });
    await expect(service.prepare({
      orgId: source.orgId,
      conversationId: source.conversationId,
      uploadedFileCount: 0,
      annotations: [assistantAnnotation(source, body, {
        id: randomUUID(),
        selectedText: " before shipping.",
        start: end,
        end: body.length,
        prefix: body.slice(Math.max(0, end - 160), end),
        suffix: "",
        attachmentFileIndexes: [],
      })],
    })).resolves.toMatchObject({
      annotations: [expect.objectContaining({
        selectedText: " before shipping.",
      })],
    });

    const otherOrgId = randomUUID();
    const otherIssueId = randomUUID();
    await db.insert(organizations).values({
      id: otherOrgId,
      name: "Other annotation organization",
      urlKey: `other-annotation-${otherOrgId}`,
      issuePrefix: `O${otherOrgId.replaceAll("-", "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: otherIssueId,
      orgId: otherOrgId,
      title: "Private cross-org issue",
      identifier: "PRIVATE-1",
    });
    const crossOrgBody = `[stale](${buildIssueMentionHref(otherIssueId, "PRIVATE-1")})`;
    await db.update(chatMessages)
      .set({ body: crossOrgBody })
      .where(eq(chatMessages.id, source.sourceMessageId));
    await expect(service.prepare({
      orgId: source.orgId,
      conversationId: source.conversationId,
      uploadedFileCount: 0,
      annotations: [{
        ...annotation,
        id: randomUUID(),
        selectedText: "PRIVATE-1 Private cross-org issue",
        sourceHash: sha256(crossOrgBody),
        start: 0,
        end: crossOrgBody.length,
        prefix: "",
        suffix: "",
      }] as ChatInlineAnnotationInput[],
    })).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("selected text"),
    });
  });

  it("rejects malformed encoded issue hrefs without surfacing a URIError", async () => {
    const body = "Review [x](/issues/%E0%A4%A) before shipping.";
    const source = await seedSource({ body });
    const link = "[x](/issues/%E0%A4%A)";
    const start = body.indexOf(link);

    await expect(service.prepare({
      orgId: source.orgId,
      conversationId: source.conversationId,
      uploadedFileCount: 0,
      annotations: [{
        id: randomUUID(),
        surface: "assistant_body",
        selectedText: "fabricated issue label",
        comment: null,
        sourceConversationId: source.conversationId,
        sourceMessageId: source.sourceMessageId,
        sourceHash: sha256(body),
        start,
        end: start + link.length,
        prefix: body.slice(0, start),
        suffix: body.slice(start + link.length),
        attachmentIds: [],
      }],
    })).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("selected text"),
    });
  });

  it.each([
    ["omitted rendered characters", "中文文档 与 npm test verify.\nSecond block."],
    ["altered block whitespace", "中文文档 与 npm test & verify. Second block."],
    ["inserted rendered characters", "中文文档 与 npm test & verify. EXTRA\nSecond block."],
  ])("rejects %s from an otherwise valid Markdown range", async (_label, selectedText) => {
    const body = [
      "## 说明",
      "",
      "阅读 [中文文档](https://example.test/docs) 与 `npm test` &amp; verify.",
      "",
      "Second block.",
    ].join("\n");
    const source = await seedSource({ body });
    const start = body.indexOf("中文文档");
    const end = body.indexOf("Second block.") + "Second block.".length;

    await expect(service.prepare({
      orgId: source.orgId,
      conversationId: source.conversationId,
      uploadedFileCount: 0,
      annotations: [{
        id: randomUUID(),
        surface: "assistant_body",
        selectedText,
        comment: null,
        sourceConversationId: source.conversationId,
        sourceMessageId: source.sourceMessageId,
        sourceHash: sha256(body),
        start,
        end,
        prefix: body.slice(Math.max(0, start - 12), start),
        suffix: body.slice(end, end + 12),
        attachmentIds: [],
      }],
    })).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("selected text"),
    });
  });

  it("rejects a zero-width-only rendered selection", async () => {
    const body = "\u200b";
    const source = await seedSource({ body });

    await expect(service.prepare({
      orgId: source.orgId,
      conversationId: source.conversationId,
      uploadedFileCount: 0,
      annotations: [{
        id: randomUUID(),
        surface: "assistant_body",
        selectedText: body,
        comment: null,
        sourceConversationId: source.conversationId,
        sourceMessageId: source.sourceMessageId,
        sourceHash: sha256(body),
        start: 0,
        end: body.length,
        prefix: "",
        suffix: "",
        attachmentIds: [],
      }],
    })).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("visible text"),
    });
  });

  it("rejects fabricated assistant selected text even when the raw range contains Markdown", async () => {
    const body = "Read [the docs](https://example.test) and `run tests` before shipping.";
    const source = await seedSource({ body });

    await expect(service.prepare({
      orgId: source.orgId,
      conversationId: source.conversationId,
      annotations: [assistantAnnotation(source, body, {
        selectedText: "fabricated anchor",
        attachmentFileIndexes: [],
      })],
      uploadedFileCount: 0,
    })).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("selected text"),
    });
  });

  it.each([
    ["wrong source hash", { sourceHash: "0".repeat(64) }, "source hash"],
    ["out-of-bounds source range", { end: 10_000 }, "source range"],
    ["stale prefix", { prefix: "wrong" }, "prefix"],
    ["stale suffix", { suffix: "wrong" }, "suffix"],
    ["wrong source conversation", { sourceConversationId: randomUUID() }, "conversation"],
  ])("rejects %s before canonicalization", async (_label, overrides, expectedMessage) => {
    const body = "Read [the docs](https://example.test) and `run tests` before shipping.";
    const source = await seedSource({ body });

    await expect(service.prepare({
      orgId: source.orgId,
      conversationId: source.conversationId,
      annotations: [assistantAnnotation(source, body, overrides)],
      uploadedFileCount: 1,
    })).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining(expectedMessage),
    });
  });

  it.each([
    ["user source", { role: "user" as const }, "assistant"],
    ["streaming source", { status: "streaming" as const }, "stable"],
    ["interrupted source", { status: "interrupted" as const }, "stable"],
    ["superseded source", { supersededAt: new Date() }, "visible"],
  ])("rejects a %s message", async (_label, sourceOverrides, expectedMessage) => {
    const body = "Stable answer";
    const source = await seedSource({ body, ...sourceOverrides });

    await expect(service.prepare({
      orgId: source.orgId,
      conversationId: source.conversationId,
      annotations: [assistantAnnotation(source, body, {
        selectedText: "Stable",
        start: 0,
        end: 6,
        prefix: "",
        suffix: " answer",
        attachmentFileIndexes: [],
      })],
      uploadedFileCount: 0,
    })).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining(expectedMessage),
    });
  });

  it("rejects a source message owned by another organization", async () => {
    const body = "Stable answer";
    const source = await seedSource({ body });
    const otherOrgId = randomUUID();
    await db.insert(organizations).values({
      id: otherOrgId,
      name: "Other annotation org",
      urlKey: `other-annotation-${otherOrgId}`,
      issuePrefix: `O${otherOrgId.replaceAll("-", "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await expect(service.prepare({
      orgId: otherOrgId,
      conversationId: source.conversationId,
      annotations: [assistantAnnotation(source, body, {
        selectedText: "Stable",
        start: 0,
        end: 6,
        prefix: "",
        suffix: " answer",
        attachmentFileIndexes: [],
      })],
      uploadedFileCount: 0,
    })).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("organization"),
    });
  });

  it.each(["another message", "another organization"])(
    "rejects an existing annotation attachment from %s",
    async (ownershipScenario) => {
      const body = "Stable answer";
      const source = await seedSource({ body });
      const editMessageId = randomUUID();
      await db.insert(chatMessages).values({
        id: editMessageId,
        orgId: source.orgId,
        conversationId: source.conversationId,
        role: "user",
        kind: "message",
        status: "completed",
        body: "Edit target",
      });

      let attachmentOrgId = source.orgId;
      let attachmentConversationId = source.conversationId;
      if (ownershipScenario === "another organization") {
        attachmentOrgId = randomUUID();
        attachmentConversationId = randomUUID();
        await db.insert(organizations).values({
          id: attachmentOrgId,
          name: "Attachment owner",
          urlKey: `attachment-owner-${attachmentOrgId}`,
          issuePrefix: `X${attachmentOrgId.replaceAll("-", "").slice(0, 5).toUpperCase()}`,
          requireBoardApprovalForNewAgents: false,
        });
        await db.insert(chatConversations).values({
          id: attachmentConversationId,
          orgId: attachmentOrgId,
          title: "Attachment owner",
        });
      }
      const ownerMessageId = randomUUID();
      await db.insert(chatMessages).values({
        id: ownerMessageId,
        orgId: attachmentOrgId,
        conversationId: attachmentConversationId,
        role: "user",
        kind: "message",
        status: "completed",
        body: "Attachment owner",
      });
      const [asset] = await db.insert(assets).values({
        orgId: attachmentOrgId,
        provider: "local_disk",
        objectKey: `annotation/${randomUUID()}`,
        contentType: "text/plain",
        byteSize: 4,
        sha256: "asset",
      }).returning();
      const [borrowedAttachment] = await db.insert(chatAttachments).values({
        orgId: attachmentOrgId,
        conversationId: attachmentConversationId,
        messageId: ownerMessageId,
        assetId: asset!.id,
      }).returning();
      const annotation = assistantAnnotation(source, body, {
        selectedText: "Stable",
        start: 0,
        end: 6,
        prefix: "",
        suffix: " answer",
        attachmentIds: [borrowedAttachment!.id],
        attachmentFileIndexes: [],
      });
      const {
        attachmentFileIndexes: _attachmentFileIndexes,
        ...persistedAnnotation
      } = annotation;
      await db
        .update(chatMessages)
        .set({ structuredPayload: { inlineAnnotations: [persistedAnnotation] } })
        .where(eq(chatMessages.id, editMessageId));

      await expect(service.prepare({
        orgId: source.orgId,
        conversationId: source.conversationId,
        editUserMessageId: editMessageId,
        annotations: [annotation],
        uploadedFileCount: 0,
      })).rejects.toMatchObject({
        status: 422,
        message: expect.stringContaining("edited user message"),
      });
    },
  );

  it("rejects an invalid uploaded file index before any attachment can be staged", async () => {
    const body = "Stable answer";
    const source = await seedSource({ body });

    await expect(service.prepare({
      orgId: source.orgId,
      conversationId: source.conversationId,
      annotations: [assistantAnnotation(source, body, {
        selectedText: "Stable",
        start: 0,
        end: 6,
        prefix: "",
        suffix: " answer",
        attachmentFileIndexes: [1],
      })],
      uploadedFileCount: 1,
    })).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("file index"),
    });
  });

  it("anchors Process selections to one terminal generation's visible prose event range", async () => {
    const source = await seedSource({ body: "Final answer" });
    const generationId = randomUUID();
    await db.insert(chatGenerations).values({
      id: generationId,
      orgId: source.orgId,
      conversationId: source.conversationId,
      status: "completed",
      completedAt: new Date(),
    });
    await db.insert(chatGenerationEvents).values([
      {
        orgId: source.orgId,
        generationId,
        generationSeq: 1,
        attemptEpoch: 1,
        eventKind: "transcript",
        payload: {
          entry: {
            kind: "thinking",
            ts: "2026-07-23T10:00:00.000Z",
            text: "Inspect [the docs](https://example.test) ",
            delta: true,
          },
        },
        assistantMessageId: source.sourceMessageId,
      },
      {
        orgId: source.orgId,
        generationId,
        generationSeq: 2,
        attemptEpoch: 1,
        eventKind: "transcript",
        payload: {
          entry: {
            kind: "thinking",
            ts: "2026-07-23T10:00:01.000Z",
            text: "before editing.",
            delta: true,
          },
        },
        assistantMessageId: source.sourceMessageId,
      },
    ]);
    const processSource = "Inspect [the docs](https://example.test) before editing.";
    await db.update(chatMessages).set({
      structuredPayload: {
        __chatTranscript: [{
          kind: "thinking",
          ts: "2026-07-23T10:00:01.000Z",
          text: processSource,
          delta: true,
          generationId,
          generationSeqStart: 1,
          generationSeqEnd: 2,
        }],
      },
    }).where(eq(chatMessages.id, source.sourceMessageId));
    const annotation: ChatInlineAnnotationInput = {
      id: randomUUID(),
      surface: "process_transcript",
      transcriptKind: "thinking",
      selectedText: "the docs before editing.",
      comment: null,
      sourceConversationId: source.conversationId,
      sourceMessageId: source.sourceMessageId,
      sourceHash: sha256(processSource),
      generationId,
      generationSeqStart: 1,
      generationSeqEnd: 2,
      start: processSource.indexOf("the docs"),
      end: processSource.indexOf("editing.") + "editing.".length,
      prefix: processSource.slice(0, processSource.indexOf("the docs")),
      suffix: "",
      attachmentIds: [],
    };

    await expect(service.prepare({
      orgId: source.orgId,
      conversationId: source.conversationId,
      annotations: [annotation],
      uploadedFileCount: 0,
    })).resolves.toMatchObject({
      annotations: [expect.objectContaining({
        generationId,
        generationSeqStart: 1,
        generationSeqEnd: 2,
      })],
    });
  });

  it("accepts Process evidence from the exact parent anchor of a Side Chat", async () => {
    const source = await seedSource({ body: "Final answer" });
    const evidence = await seedProcessEvidence({
      source,
      text: "Inspect the parent process evidence.",
    });
    const sideConversationId = randomUUID();
    await db.insert(chatConversations).values({
      id: sideConversationId,
      orgId: source.orgId,
      title: "Process annotation Side Chat",
      conversationKind: "side_chat",
      sideChatState: "active",
      forkedFromConversationId: source.conversationId,
      forkedFromMessageId: source.sourceMessageId,
    });

    await expect(service.prepare({
      orgId: source.orgId,
      conversationId: sideConversationId,
      uploadedFileCount: 0,
      annotations: [{
        id: randomUUID(),
        surface: "process_transcript",
        transcriptKind: "thinking",
        selectedText: evidence.text,
        comment: null,
        sourceConversationId: source.conversationId,
        sourceMessageId: source.sourceMessageId,
        sourceHash: sha256(evidence.text),
        generationId: evidence.generationId,
        generationSeqStart: 1,
        generationSeqEnd: 1,
        start: 0,
        end: evidence.text.length,
        prefix: "",
        suffix: "",
        attachmentIds: [],
      }],
    })).resolves.toMatchObject({
      annotations: [expect.objectContaining({
        sourceConversationId: source.conversationId,
        sourceMessageId: source.sourceMessageId,
        generationId: evidence.generationId,
      })],
    });
  });

  it("rejects hidden thinking evidence even when its text appears in the visible projection", async () => {
    const source = await seedSource({ body: "Final answer" });
    const evidence = await seedProcessEvidence({
      source,
      entryOverrides: { visibility: "internal" },
    });
    const annotation: ChatInlineAnnotationInput = {
      id: randomUUID(),
      surface: "process_transcript",
      transcriptKind: "thinking",
      selectedText: evidence.text,
      sourceConversationId: source.conversationId,
      sourceMessageId: source.sourceMessageId,
      sourceHash: sha256(evidence.text),
      generationId: evidence.generationId,
      generationSeqStart: 1,
      generationSeqEnd: 1,
      start: 0,
      end: evidence.text.length,
      prefix: "",
      suffix: "",
      attachmentIds: [],
    };

    await expect(service.prepare({
      orgId: source.orgId,
      conversationId: source.conversationId,
      annotations: [annotation],
      uploadedFileCount: 0,
    })).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("visible assistant or thinking prose"),
    });
  });

  it("rejects Process evidence that is absent from the visible message projection", async () => {
    const source = await seedSource({ body: "Final answer" });
    const evidence = await seedProcessEvidence({
      source,
      projectToVisibleMessage: false,
    });
    const annotation: ChatInlineAnnotationInput = {
      id: randomUUID(),
      surface: "process_transcript",
      transcriptKind: "thinking",
      selectedText: evidence.text,
      sourceConversationId: source.conversationId,
      sourceMessageId: source.sourceMessageId,
      sourceHash: sha256(evidence.text),
      generationId: evidence.generationId,
      generationSeqStart: 1,
      generationSeqEnd: 1,
      start: 0,
      end: evidence.text.length,
      prefix: "",
      suffix: "",
      attachmentIds: [],
    };

    await expect(service.prepare({
      orgId: source.orgId,
      conversationId: source.conversationId,
      annotations: [annotation],
      uploadedFileCount: 0,
    })).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("visible message projection"),
    });
  });

  it("rejects the assistant final-answer suffix hidden by the Chat Process projection", async () => {
    const finalAnswer = "Final answer";
    const processSource = `Exploration\n${finalAnswer}`;
    const source = await seedSource({ body: finalAnswer });
    const evidence = await seedProcessEvidence({
      source,
      text: processSource,
      entryOverrides: { kind: "assistant" },
    });
    const start = processSource.indexOf(finalAnswer);
    const annotation: ChatInlineAnnotationInput = {
      id: randomUUID(),
      surface: "process_transcript",
      transcriptKind: "assistant",
      selectedText: finalAnswer,
      sourceConversationId: source.conversationId,
      sourceMessageId: source.sourceMessageId,
      sourceHash: sha256(processSource),
      generationId: evidence.generationId,
      generationSeqStart: 1,
      generationSeqEnd: 1,
      start,
      end: processSource.length,
      prefix: processSource.slice(0, start),
      suffix: "",
      attachmentIds: [],
    };

    await expect(service.prepare({
      orgId: source.orgId,
      conversationId: source.conversationId,
      annotations: [annotation],
      uploadedFileCount: 0,
    })).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("visible message projection"),
    });
  });

  it("accepts the visible assistant Process prefix after final-answer suffix redaction", async () => {
    const visibleProcess = "Exploration";
    const finalAnswer = "Final answer";
    const processSource = `${visibleProcess}\n${finalAnswer}`;
    const source = await seedSource({ body: finalAnswer });
    const evidence = await seedProcessEvidence({
      source,
      text: processSource,
      entryOverrides: { kind: "assistant" },
    });
    const annotation: ChatInlineAnnotationInput = {
      id: randomUUID(),
      surface: "process_transcript",
      transcriptKind: "assistant",
      selectedText: visibleProcess,
      sourceConversationId: source.conversationId,
      sourceMessageId: source.sourceMessageId,
      sourceHash: sha256(visibleProcess),
      generationId: evidence.generationId,
      generationSeqStart: 1,
      generationSeqEnd: 1,
      start: 0,
      end: visibleProcess.length,
      prefix: "",
      suffix: "",
      attachmentIds: [],
    };

    await expect(service.prepare({
      orgId: source.orgId,
      conversationId: source.conversationId,
      annotations: [annotation],
      uploadedFileCount: 0,
    })).resolves.toMatchObject({
      annotations: [expect.objectContaining({
        selectedText: visibleProcess,
        sourceHash: sha256(visibleProcess),
      })],
    });
  });

  it("rejects assistant protocol text hidden by the Chat Process projection", async () => {
    const processSource = "Visible investigation\nRUDDER_RESULT_BEGIN\nPRIVATE_FINAL_PROTOCOL";
    const source = await seedSource({ body: "Final answer" });
    const evidence = await seedProcessEvidence({
      source,
      text: processSource,
      entryOverrides: { kind: "assistant" },
    });
    const selectedText = "PRIVATE_FINAL_PROTOCOL";
    const start = processSource.indexOf(selectedText);
    const annotation: ChatInlineAnnotationInput = {
      id: randomUUID(),
      surface: "process_transcript",
      transcriptKind: "assistant",
      selectedText,
      sourceConversationId: source.conversationId,
      sourceMessageId: source.sourceMessageId,
      sourceHash: sha256(processSource),
      generationId: evidence.generationId,
      generationSeqStart: 1,
      generationSeqEnd: 1,
      start,
      end: start + selectedText.length,
      prefix: processSource.slice(Math.max(0, start - 160), start),
      suffix: "",
      attachmentIds: [],
    };

    await expect(service.prepare({
      orgId: source.orgId,
      conversationId: source.conversationId,
      annotations: [annotation],
      uploadedFileCount: 0,
    })).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("visible message projection"),
    });
  });

  it("rejects protocol text split across hidden lifecycle transcript entries", async () => {
    const source = await seedSource({ body: "Final answer" });
    const generationId = randomUUID();
    const ts = "2026-07-23T10:00:00.000Z";
    const privateChunk = "BEGIN\nPRIVATE_PROTOCOL";
    await db.insert(chatGenerations).values({
      id: generationId,
      orgId: source.orgId,
      conversationId: source.conversationId,
      status: "completed",
      completedAt: new Date(),
    });
    await db.insert(chatGenerationEvents).values([
      {
        orgId: source.orgId,
        generationId,
        generationSeq: 1,
        attemptEpoch: 1,
        eventKind: "transcript",
        payload: { entry: { kind: "assistant", ts, text: "RUDDER_RESULT_", delta: true } },
        assistantMessageId: source.sourceMessageId,
      },
      {
        orgId: source.orgId,
        generationId,
        generationSeq: 2,
        attemptEpoch: 1,
        eventKind: "transcript",
        payload: { entry: { kind: "system", ts, text: "reasoning completed" } },
        assistantMessageId: source.sourceMessageId,
      },
      {
        orgId: source.orgId,
        generationId,
        generationSeq: 3,
        attemptEpoch: 1,
        eventKind: "transcript",
        payload: { entry: { kind: "assistant", ts, text: privateChunk, delta: true } },
        assistantMessageId: source.sourceMessageId,
      },
    ]);
    await db.update(chatMessages).set({
      structuredPayload: {
        __chatTranscript: [
          {
            kind: "assistant",
            ts,
            text: "RUDDER_RESULT_",
            delta: true,
            generationId,
            generationSeqStart: 1,
            generationSeqEnd: 1,
          },
          {
            kind: "system",
            ts,
            text: "reasoning completed",
            generationId,
            generationSeqStart: 2,
            generationSeqEnd: 2,
          },
          {
            kind: "assistant",
            ts,
            text: privateChunk,
            delta: true,
            generationId,
            generationSeqStart: 3,
            generationSeqEnd: 3,
          },
        ],
      },
    }).where(eq(chatMessages.id, source.sourceMessageId));
    const selectedText = "PRIVATE_PROTOCOL";
    const start = privateChunk.indexOf(selectedText);

    await expect(service.prepare({
      orgId: source.orgId,
      conversationId: source.conversationId,
      uploadedFileCount: 0,
      annotations: [{
        id: randomUUID(),
        surface: "process_transcript",
        transcriptKind: "assistant",
        selectedText,
        comment: null,
        sourceConversationId: source.conversationId,
        sourceMessageId: source.sourceMessageId,
        sourceHash: sha256(privateChunk),
        generationId,
        generationSeqStart: 3,
        generationSeqEnd: 3,
        start,
        end: start + selectedText.length,
        prefix: privateChunk.slice(0, start),
        suffix: "",
        attachmentIds: [],
      }],
    })).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("visible message projection"),
    });
  });

  it("rejects fabricated selected text for a plain Process source range", async () => {
    const source = await seedSource({ body: "Final answer" });
    const evidence = await seedProcessEvidence({ source });
    const annotation: ChatInlineAnnotationInput = {
      id: randomUUID(),
      surface: "process_transcript",
      transcriptKind: "thinking",
      selectedText: "Fabricated",
      sourceConversationId: source.conversationId,
      sourceMessageId: source.sourceMessageId,
      sourceHash: sha256(evidence.text),
      generationId: evidence.generationId,
      generationSeqStart: 1,
      generationSeqEnd: 1,
      start: 0,
      end: evidence.text.length,
      prefix: "",
      suffix: "",
      attachmentIds: [],
    };

    await expect(service.prepare({
      orgId: source.orgId,
      conversationId: source.conversationId,
      annotations: [annotation],
      uploadedFileCount: 0,
    })).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("selected text"),
    });
  });

  it("accepts rendered Process selections across Markdown, CJK, entities, whitespace, and blocks", async () => {
    const source = await seedSource({ body: "Final answer" });
    const processSource = [
      "检查 [中文文档](https://example.test/docs) 与 `npm test` &amp; verify.",
      "",
      "Second block.",
    ].join("\n");
    const evidence = await seedProcessEvidence({ source, text: processSource });

    await expect(service.prepare({
      orgId: source.orgId,
      conversationId: source.conversationId,
      uploadedFileCount: 0,
      annotations: [{
        id: randomUUID(),
        surface: "process_transcript",
        transcriptKind: "thinking",
        selectedText: "中文文档 与 npm test & verify.\nSecond block.",
        comment: null,
        sourceConversationId: source.conversationId,
        sourceMessageId: source.sourceMessageId,
        sourceHash: sha256(processSource),
        generationId: evidence.generationId,
        generationSeqStart: 1,
        generationSeqEnd: 1,
        start: processSource.indexOf("中文文档"),
        end: processSource.length,
        prefix: processSource.slice(0, processSource.indexOf("中文文档")),
        suffix: "",
        attachmentIds: [],
      }],
    })).resolves.toMatchObject({
      annotations: [expect.objectContaining({
        selectedText: "中文文档 与 npm test & verify.\nSecond block.",
      })],
    });
  });

  it("rejects fabricated Process selected text when the raw range contains Markdown", async () => {
    const source = await seedSource({ body: "Final answer" });
    const processSource = "Inspect [the docs](https://example.test) before editing.";
    const evidence = await seedProcessEvidence({ source, text: processSource });

    await expect(service.prepare({
      orgId: source.orgId,
      conversationId: source.conversationId,
      uploadedFileCount: 0,
      annotations: [{
        id: randomUUID(),
        surface: "process_transcript",
        transcriptKind: "thinking",
        selectedText: "fabricated process anchor",
        comment: null,
        sourceConversationId: source.conversationId,
        sourceMessageId: source.sourceMessageId,
        sourceHash: sha256(processSource),
        generationId: evidence.generationId,
        generationSeqStart: 1,
        generationSeqEnd: 1,
        start: 0,
        end: processSource.length,
        prefix: "",
        suffix: "",
        attachmentIds: [],
      }],
    })).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("selected text"),
    });
  });

  it.each([
    ["nonterminal generation", "running", "terminal"],
    ["wrong generation identity", "wrong_generation", "generation"],
    ["non-prose evidence", "tool", "visible"],
    ["missing evidence", "missing", "evidence"],
  ])("rejects Process annotation with %s", async (_label, scenario, expectedMessage) => {
    const source = await seedSource({ body: "Final answer" });
    const generationId = randomUUID();
    await db.insert(chatGenerations).values({
      id: generationId,
      orgId: source.orgId,
      conversationId: source.conversationId,
      status: scenario === "running" ? "running" : "completed",
      completedAt: scenario === "running" ? null : new Date(),
    });
    if (scenario !== "missing") {
      await db.insert(chatGenerationEvents).values({
        orgId: source.orgId,
        generationId,
        generationSeq: 1,
        attemptEpoch: 1,
        eventKind: "transcript",
        payload: {
          entry: scenario === "tool"
            ? { kind: "tool_call", ts: "2026-07-23T10:00:00.000Z", name: "shell", input: {} }
            : { kind: "thinking", ts: "2026-07-23T10:00:00.000Z", text: "Inspect", delta: true },
        },
        assistantMessageId: source.sourceMessageId,
      });
    }
    const evidence = "Inspect";
    const annotation: ChatInlineAnnotationInput = {
      id: randomUUID(),
      surface: "process_transcript",
      transcriptKind: "thinking",
      selectedText: evidence,
      sourceConversationId: source.conversationId,
      sourceMessageId: source.sourceMessageId,
      sourceHash: sha256(evidence),
      generationId: scenario === "wrong_generation" ? randomUUID() : generationId,
      generationSeqStart: 1,
      generationSeqEnd: 1,
      start: 0,
      end: evidence.length,
      prefix: "",
      suffix: "",
      attachmentIds: [],
    };

    await expect(service.prepare({
      orgId: source.orgId,
      conversationId: source.conversationId,
      annotations: [annotation],
      uploadedFileCount: 0,
    })).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining(expectedMessage),
    });
  });
});
