import type { TranscriptEntry } from "@rudderhq/agent-runtime-utils";
import {
  agents,
  applyPendingMigrations,
  assets,
  chatAttachments,
  chatConversations,
  chatGenerationEvents,
  chatGenerations,
  chatMessages,
  chatMessageTranscriptEntries,
  createDb,
  ensurePostgresDatabase,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  nativeSegments,
  organizations,
  organizationSkills,
  runRuntimeSpans,
  runtimeBindings,
  runtimeSourceAliases,
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
import { createHistoricalTranscriptReader } from "./runtime-kernel/historical-transcript-reader.js";
import { createTranscriptObjectStore } from "./runtime-kernel/transcript-object-store.js";

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
  let workspaceHome = "";
  let originalWorkspaceHome: string | undefined;
  let transcriptObjectDir = "";
  let previousTranscriptObjectBasePath: string | undefined;

  beforeAll(async () => {
    const started = await startTempDatabase();
    originalWorkspaceHome = process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME;
    workspaceHome = path.join(
      started.dataDir || os.tmpdir(),
      `rudder-annotation-workspaces-${randomUUID()}`,
    );
    fs.mkdirSync(workspaceHome, { recursive: true });
    process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME = workspaceHome;
    transcriptObjectDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-chat-annotation-transcripts-"));
    previousTranscriptObjectBasePath = process.env.RUDDER_TRANSCRIPT_OBJECT_BASE_PATH;
    process.env.RUDDER_TRANSCRIPT_OBJECT_BASE_PATH = transcriptObjectDir;
    db = createDb(started.connectionString);
    service = chatInlineAnnotationService(db);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 30_000);

  afterEach(async () => {
    await db.delete(runtimeSourceAliases);
    await db.delete(runRuntimeSpans);
    await db.delete(nativeSegments);
    await db.delete(runtimeBindings);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(chatGenerationEvents);
    await db.delete(chatGenerations);
    await db.delete(chatMessageTranscriptEntries);
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
    if (workspaceHome) {
      fs.rmSync(workspaceHome, {
        recursive: true,
        force: true,
      });
      if (originalWorkspaceHome === undefined) {
        delete process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME;
      } else {
        process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME = originalWorkspaceHome;
      }
    }
    if (previousTranscriptObjectBasePath === undefined) delete process.env.RUDDER_TRANSCRIPT_OBJECT_BASE_PATH;
    else process.env.RUDDER_TRANSCRIPT_OBJECT_BASE_PATH = previousTranscriptObjectBasePath;
    if (transcriptObjectDir) fs.rmSync(transcriptObjectDir, { recursive: true, force: true });
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

  async function seedRunReaderTranscript(
    source: Awaited<ReturnType<typeof seedSource>>,
    entries: readonly TranscriptEntry[],
  ) {
    const agentId = randomUUID();
    const runId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      orgId: source.orgId,
      name: "Reader-backed annotation agent",
      agentRuntimeType: "process",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      orgId: source.orgId,
      agentId,
      status: "succeeded",
      finishedAt: new Date(),
      chatConversationId: source.conversationId,
    });

    const bindingId = randomUUID();
    const segmentId = randomUUID();
    const spanId = randomUUID();
    const ownerToken = randomUUID();
    const openedAt = new Date("2026-07-23T09:00:00.000Z");
    const closedAt = new Date("2026-07-23T09:01:00.000Z");
    await db.insert(runtimeBindings).values({
      id: bindingId,
      orgId: source.orgId,
      conversationId: source.conversationId,
      principalScopeRef: `board:annotation-reader:${runId}`,
      agentId,
      runtimeType: "process",
      continuity: "native",
      status: "active",
    });
    await db.insert(nativeSegments).values({
      id: segmentId,
      orgId: source.orgId,
      bindingId,
      runtimeType: "process",
      segmentOrdinal: 0,
      nativeSessionId: `annotation-reader-${runId}`,
      rootSessionId: `annotation-reader-${runId}`,
      state: "sealed",
      createdAt: openedAt,
      sealedAt: closedAt,
      updatedAt: closedAt,
    });
    await db.insert(runRuntimeSpans).values({
      id: spanId,
      orgId: source.orgId,
      runId,
      bindingId,
      segmentId,
      attemptRef: `annotation-reader-attempt-${runId}`,
      attemptEpoch: 1,
      ownerToken,
      ordinal: 0,
      relation: "primary",
      selectorJson: { kind: "native_execution", runtimeType: "process", runId },
      state: "sealed",
      completeness: "complete",
      openedAt,
      closedAt,
      writerLeaseReleasedAt: closedAt,
      updatedAt: closedAt,
    });
    const objectRef = await createTranscriptObjectStore(transcriptObjectDir).write({
      orgId: source.orgId,
      runId,
      spanId,
      ownerToken,
      entries,
    });
    await db.update(runRuntimeSpans)
      .set({ supplementalObjectRef: objectRef })
      .where(eq(runRuntimeSpans.id, spanId));
    return { agentId, runId };
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

  async function seedForkRunAnnotation(input: {
    source: Awaited<ReturnType<typeof seedSource>>;
    run: Awaited<ReturnType<typeof seedAgentRunEvidence>>;
    requesterUserId: string;
    annotationOverrides?: Partial<Extract<ChatInlineAnnotationInput, { surface: "agent_run_transcript" }>>;
  }) {
    const [firstEvent, secondEvent] = input.run.events;
    const attachmentId = randomUUID();
    const annotatedMessageId = randomUUID();
    const fileBytes = Buffer.from("forked annotation evidence file", "utf8");
    const [asset] = await db.insert(assets).values({
      orgId: input.source.orgId,
      provider: "local",
      objectKey: `fork-annotation-${randomUUID()}`,
      contentType: "text/plain",
      byteSize: fileBytes.byteLength,
      sha256: sha256(fileBytes.toString("utf8")),
      originalFilename: "fork-evidence.txt",
      createdByUserId: input.requesterUserId,
    }).returning();
    const annotation: ChatInlineAnnotationInput = {
      id: randomUUID(),
      surface: "agent_run_transcript",
      selectedText: "the docs before shipping.",
      comment: "Keep this Run evidence.",
      sourceRunId: input.run.runId,
      sourceAgentId: input.run.agentId,
      anchorKind: "text",
      sourceEntryId: firstEvent!.id,
      sourceMemberIds: [firstEvent!.id, secondEvent!.id],
      sourceHash: sha256("Review the docs before shipping."),
      attachmentIds: [attachmentId],
      ...input.annotationOverrides,
    } as ChatInlineAnnotationInput;
    await db.insert(chatMessages).values({
      id: annotatedMessageId,
      orgId: input.source.orgId,
      conversationId: input.source.conversationId,
      role: "user",
      kind: "message",
      status: "completed",
      body: "Please explain this Run evidence.",
      structuredPayload: { inlineAnnotations: [annotation] },
    });
    await db.insert(chatAttachments).values({
      id: attachmentId,
      orgId: input.source.orgId,
      conversationId: input.source.conversationId,
      messageId: annotatedMessageId,
      assetId: asset!.id,
    });
    return { annotation, annotatedMessageId, attachmentId, asset: asset!, fileBytes };
  }

  it("copies a same-organization Run Detail annotation as immutable source evidence with child-owned attachment identity", async () => {
    const source = await seedSource();
    const requesterUserId = "fork-requester";
    const run = await seedAgentRunEvidence(source);
    const seeded = await seedForkRunAnnotation({ source, run, requesterUserId });
    const chats = chatService(db);

    const fork = await chats.forkConversation({
      sourceConversationId: source.conversationId,
      orgId: source.orgId,
      userId: requesterUserId,
      createdByUserId: requesterUserId,
    });
    if (!fork) throw new Error("Fork conversation was not returned");
    const [forkedConversation] = await db.select().from(chatConversations)
      .where(eq(chatConversations.id, fork.id));
    const [forkedMessage] = await db.select().from(chatMessages)
      .where(eq(chatMessages.conversationId, fork.id))
      .then((messages) => messages.filter((message) => message.body === "Please explain this Run evidence."));
    if (!forkedMessage) throw new Error("Forked annotation message was not copied");
    const [copiedAnnotation] = (forkedMessage?.structuredPayload?.inlineAnnotations ?? []) as Array<
      Extract<ChatInlineAnnotationInput, { surface: "agent_run_transcript" }>
    >;
    if (!copiedAnnotation) throw new Error("Forked Run annotation was not copied");
    const [copiedAttachmentId] = copiedAnnotation.attachmentIds ?? [];
    if (!copiedAttachmentId) throw new Error("Forked Run annotation attachment was not rebound");
    const [copiedAttachment] = await db.select().from(chatAttachments)
      .where(eq(chatAttachments.conversationId, fork.id));

    expect(forkedConversation).toMatchObject({ status: "active", conversationKind: "chat" });
    expect(forkedMessage).toBeDefined();
    expect(copiedAnnotation).toMatchObject({
      ...seeded.annotation,
      attachmentIds: [expect.any(String)],
    });
    expect(copiedAttachmentId).not.toBe(seeded.attachmentId);
    expect(copiedAnnotation).not.toHaveProperty("sourceConversationId");
    expect(copiedAnnotation).not.toHaveProperty("sourceMessageId");
    expect(copiedAttachment).toMatchObject({
      id: copiedAttachmentId,
      orgId: source.orgId,
      conversationId: fork.id,
      messageId: forkedMessage?.id,
      assetId: seeded.asset.id,
    });
    const [copiedAsset] = await db.select().from(assets).where(eq(assets.id, seeded.asset.id));
    expect(copiedAsset).toMatchObject({
      byteSize: seeded.fileBytes.byteLength,
      sha256: sha256(seeded.fileBytes.toString("utf8")),
      originalFilename: "fork-evidence.txt",
    });
  });

  it.each(["agent", "member", "hash", "terminal", "organization", "permission"] as const)(
    "rejects a Fork copy with forged or inaccessible Run %s provenance and rolls back copied rows",
    async (failure) => {
      const source = await seedSource();
      const requesterUserId = "fork-requester";
      const run = await seedAgentRunEvidence(source);
      let annotationOverrides: Partial<Extract<ChatInlineAnnotationInput, { surface: "agent_run_transcript" }>> = {};

      if (failure === "agent") annotationOverrides = { sourceAgentId: randomUUID() };
      if (failure === "member") annotationOverrides = { sourceMemberIds: [randomUUID()] };
      if (failure === "hash") annotationOverrides = { sourceHash: "a".repeat(64) };
      if (failure === "terminal") {
        await db.update(heartbeatRuns).set({ status: "running" })
          .where(eq(heartbeatRuns.id, run.runId));
      }
      if (failure === "organization") {
        const foreign = await seedSource({ body: "Foreign annotation source" });
        const foreignRun = await seedAgentRunEvidence(foreign);
        run.runId = foreignRun.runId;
        run.agentId = foreignRun.agentId;
        run.events = foreignRun.events;
      }
      if (failure === "permission") {
        const privateConversationId = randomUUID();
        await db.insert(chatConversations).values({
          id: privateConversationId,
          orgId: source.orgId,
          conversationKind: "side_chat",
          createdByUserId: "different-side-chat-owner",
          title: "Private Run Detail",
        });
        await db.update(heartbeatRuns).set({
          chatConversationId: privateConversationId,
          scene: "side_chat",
          targetType: "chat_conversation",
          targetId: privateConversationId,
          idempotencyKey: `fork-permission-test:${run.runId}`,
          sessionIntentJson: {
            kind: "fresh",
            reuseScope: "none",
            sourceRunId: null,
            sessionId: null,
            sessionParams: null,
          },
        }).where(eq(heartbeatRuns.id, run.runId));
      }

      await seedForkRunAnnotation({
        source,
        run,
        requesterUserId,
        annotationOverrides,
      });
      const before = {
        conversations: await db.select({ id: chatConversations.id }).from(chatConversations)
          .where(eq(chatConversations.orgId, source.orgId)),
        messages: await db.select({ id: chatMessages.id }).from(chatMessages)
          .where(eq(chatMessages.orgId, source.orgId)),
        attachments: await db.select({ id: chatAttachments.id }).from(chatAttachments)
          .where(eq(chatAttachments.orgId, source.orgId)),
        aliases: await db.select({ id: runtimeSourceAliases.id }).from(runtimeSourceAliases)
          .where(eq(runtimeSourceAliases.orgId, source.orgId)),
      };
      const sortedIds = (rows: Array<{ id: string }>) => rows.map(({ id }) => id).sort();

      await expect(chatService(db).forkConversation({
        sourceConversationId: source.conversationId,
        orgId: source.orgId,
        userId: requesterUserId,
        createdByUserId: requesterUserId,
      })).rejects.toMatchObject({
        status: failure === "permission" ? 404 : 422,
      });

      expect(sortedIds(await db.select({ id: chatConversations.id }).from(chatConversations)
        .where(eq(chatConversations.orgId, source.orgId)))).toEqual(sortedIds(before.conversations));
      expect(sortedIds(await db.select({ id: chatMessages.id }).from(chatMessages)
        .where(eq(chatMessages.orgId, source.orgId)))).toEqual(sortedIds(before.messages));
      expect(sortedIds(await db.select({ id: chatAttachments.id }).from(chatAttachments)
        .where(eq(chatAttachments.orgId, source.orgId)))).toEqual(sortedIds(before.attachments));
      expect(sortedIds(await db.select({ id: runtimeSourceAliases.id }).from(runtimeSourceAliases)
        .where(eq(runtimeSourceAliases.orgId, source.orgId)))).toEqual(sortedIds(before.aliases));
    },
  );

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

  it("enforces Run Intelligence Side Chat ownership for transcript annotations", async () => {
    const target = await seedSource();
    const ownerId = "side-chat-annotation-owner";
    const sideChatId = randomUUID();
    await db.insert(chatConversations).values({
      id: sideChatId,
      orgId: target.orgId,
      conversationKind: "side_chat",
      createdByUserId: ownerId,
      title: "Private source Side Chat",
    });
    const run = await seedAgentRunEvidence(target);
    await db.update(heartbeatRuns).set({
      chatConversationId: sideChatId,
      scene: "side_chat",
      targetType: "chat_conversation",
      targetId: sideChatId,
      idempotencyKey: `annotation-test:${run.runId}`,
      sessionIntentJson: {
        kind: "fresh",
        reuseScope: "none",
        sourceRunId: null,
        sessionId: null,
        sessionParams: null,
      },
    }).where(eq(heartbeatRuns.id, run.runId));
    const [firstEvent, secondEvent] = run.events;
    const annotation: ChatInlineAnnotationInput = {
      id: randomUUID(),
      surface: "agent_run_transcript",
      selectedText: "the docs before shipping.",
      comment: null,
      sourceRunId: run.runId,
      sourceAgentId: run.agentId,
      anchorKind: "text",
      sourceEntryId: firstEvent!.id,
      sourceMemberIds: [firstEvent!.id, secondEvent!.id],
      sourceHash: sha256("Review the docs before shipping."),
      attachmentIds: [],
    };

    await expect(service.prepare({
      orgId: target.orgId,
      conversationId: target.conversationId,
      requesterUserId: ownerId,
      uploadedFileCount: 0,
      annotations: [annotation],
    })).resolves.toMatchObject({
      annotations: [expect.objectContaining({ sourceRunId: run.runId })],
    });

    await db.update(chatConversations).set({ createdByUserId: "different-owner" })
      .where(eq(chatConversations.id, sideChatId));
    await expect(service.prepare({
      orgId: target.orgId,
      conversationId: target.conversationId,
      requesterUserId: ownerId,
      uploadedFileCount: 0,
      annotations: [{ ...annotation, id: randomUUID(), sourceAgentId: randomUUID() }],
    })).rejects.toMatchObject({ status: 404 });
  });

  it("validates Cursor ACP delta text from a persisted object transcript without legacy rows", async () => {
    const source = await seedSource();
    const chunks = ["Hello ", "world"].map((text, index) => ({
      kind: "cursor:acp:agent_message_chunk",
      ts: "2026-07-23T09:00:00.000Z",
      text: text.trim(),
      sourceEntryId: `acp:update:chunk-${index}`,
      payload: {
        provider: "cursor_agent", transport: "cursor-agent-acp-stdio",
        method: "session/update", sessionId: "cursor-annotation-session",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
      },
    }));
    // The object store accepts the legacy union, while native Reader entries retain provider kinds.
    const run = await seedRunReaderTranscript(source, chunks as unknown as TranscriptEntry[]);
    expect(await db.select().from(chatMessageTranscriptEntries)
      .where(eq(chatMessageTranscriptEntries.orgId, source.orgId))).toEqual([]);
    expect(await db.select().from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, run.runId))).toEqual([]);
    const annotation: ChatInlineAnnotationInput = {
      id: randomUUID(), surface: "agent_run_transcript", anchorKind: "text",
      selectedText: "Hello world", comment: null,
      sourceRunId: run.runId, sourceAgentId: run.agentId,
      sourceEntryId: chunks[0]!.sourceEntryId,
      sourceMemberIds: chunks.map((chunk) => chunk.sourceEntryId),
      sourceHash: sha256("Hello world"), attachmentIds: [],
    };
    await expect(service.prepare({
      orgId: source.orgId, conversationId: source.conversationId,
      uploadedFileCount: 0, annotations: [annotation],
    })).resolves.toMatchObject({
      annotations: [expect.objectContaining({ sourceEntryId: chunks[0]!.sourceEntryId })],
    });
    await expect(service.prepare({
      orgId: source.orgId, conversationId: source.conversationId,
      uploadedFileCount: 0, annotations: [{ ...annotation, id: randomUUID(), sourceEntryId: "99" }],
    })).rejects.toThrow("source entry");
    await expect(service.prepare({
      orgId: source.orgId, conversationId: source.conversationId,
      uploadedFileCount: 0, annotations: [{ ...annotation, id: randomUUID(), selectedText: "Hello\nworld" }],
    })).rejects.toThrow("selected text");

    const nativeSource = await seedSource();
    const nativeRun = await seedRunReaderTranscript(nativeSource,
      chunks.map((chunk) => ({ ...chunk, origin: "native" })) as unknown as TranscriptEntry[]);
    await expect(service.prepare({
      orgId: nativeSource.orgId, conversationId: nativeSource.conversationId,
      uploadedFileCount: 0,
      annotations: [{ ...annotation, id: randomUUID(), sourceRunId: nativeRun.runId,
        sourceAgentId: nativeRun.agentId }],
    })).rejects.toThrow("visible Nice Transcript evidence");
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

  it("carries top-level Reader transcript items across an edit without a legacy transcript row", async () => {
    const source = await seedSource({ role: "user", body: "Original question" });
    const readerEntry = {
      kind: "user",
      ts: "2026-07-23T09:00:00.000Z",
      text: "Reader-backed user event",
      sourceEntryId: `message:${source.sourceMessageId}:1`,
      payload: {
        kind: "assistant",
        ts: "2026-07-23T08:59:00.000Z",
        text: "Payload text must not replace Reader text",
        messageId: "reader-message-id",
      },
    } satisfies Extract<TranscriptEntry, { kind: "user" }> & { payload: Record<string, unknown> };
    const run = await seedRunReaderTranscript(source, [readerEntry]);
    await db.update(chatMessages).set({ runId: run.runId })
      .where(eq(chatMessages.id, source.sourceMessageId));
    expect(await db.select().from(chatMessageTranscriptEntries)
      .where(eq(chatMessageTranscriptEntries.messageId, source.sourceMessageId))).toEqual([]);
    expect(await db.select().from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, run.runId))).toEqual([]);
    const readerPage = await createHistoricalTranscriptReader(db).readConversation({
      orgId: source.orgId,
      conversationId: source.conversationId,
      principal: { type: "board", orgId: source.orgId, authorized: true },
    });
    expect(readerPage.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: readerEntry.kind,
        ts: readerEntry.ts,
        text: readerEntry.text,
        payload: readerEntry.payload,
        sourceEntryId: readerEntry.sourceEntryId,
      }),
    ]));

    const persist = createChatAnnotationMessagePersistence(db, chatService(db).getMessage);
    const edited = await persist(
      source.conversationId,
      source.orgId,
      "Edited question",
      source.sourceMessageId,
    );
    const detachedEntries = await db.select().from(chatMessageTranscriptEntries)
      .where(eq(chatMessageTranscriptEntries.messageId, edited.id));

    expect(detachedEntries).toMatchObject([
      { entrySeq: 0, payload: expect.objectContaining({
        kind: "user",
        ts: readerEntry.ts,
        text: readerEntry.text,
        messageId: "reader-message-id",
        sourceEntryId: readerEntry.sourceEntryId,
      }) },
      { entrySeq: 1, payload: expect.objectContaining({
        kind: "user",
        text: "Original question",
      }) },
    ]);
    expect(edited.transcript).toEqual([
      {
        kind: "user",
        ts: readerEntry.ts,
        text: readerEntry.text,
        messageId: "reader-message-id",
        sourceEntryId: `message:${edited.id}:0`,
      },
      expect.objectContaining({
        kind: "user",
        text: "Original question",
        sourceEntryId: `message:${edited.id}:1`,
      }),
    ]);
  });

  it("converges concurrent user-message retries on one client mutation", async () => {
    const source = await seedSource({ body: "Assistant source" });
    const chats = chatService(db);
    const persist = createChatAnnotationMessagePersistence(db, chats.getMessage);
    const clientMutationId = `send:${randomUUID()}`;
    const clientMutationFingerprint = "a".repeat(64);
    const replayed = vi.fn();
    const accepted = vi.fn();

    const [first, retry] = await Promise.all([
      persist(source.conversationId, source.orgId, "Send exactly once", null, {
        clientMutationId,
        clientMutationFingerprint,
        onIdempotentReplay: replayed,
        onTransactionCommitted: accepted,
      }),
      persist(source.conversationId, source.orgId, "Send exactly once", null, {
        clientMutationId,
        clientMutationFingerprint,
        onIdempotentReplay: replayed,
        onTransactionCommitted: accepted,
      }),
    ]);

    expect(retry.id).toBe(first.id);
    expect(first).not.toHaveProperty("clientMutationId");
    expect(replayed).toHaveBeenCalledTimes(1);
    expect(accepted).toHaveBeenCalledTimes(1);
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
      { clientMutationId, clientMutationFingerprint: "b".repeat(64) },
    )).rejects.toMatchObject({ status: 409 });
  });

  it("retries deadlocked idempotent sends and preserves the error after exhaustion", async () => {
    const source = await seedSource({ body: "Assistant source" });
    const chats = chatService(db);
    const persist = createChatAnnotationMessagePersistence(db, chats.getMessage);
    const transaction = vi.spyOn(db, "transaction");
    const accepted = vi.fn();
    const replayed = vi.fn();
    const deadlock = Object.assign(new Error("deadlock detected"), { code: "40P01" });
    const wrappedDeadlock = new Error("transaction failed", { cause: deadlock });

    try {
      transaction.mockRejectedValueOnce(deadlock).mockRejectedValueOnce(wrappedDeadlock);
      const message = await persist(source.conversationId, source.orgId, "Retried send", null, {
        clientMutationId: `send:${randomUUID()}`,
        onTransactionCommitted: accepted,
        onIdempotentReplay: replayed,
      });
      expect(message.body).toBe("Retried send");
      expect(transaction).toHaveBeenCalledTimes(3);
      expect(accepted).toHaveBeenCalledTimes(1);
      expect(replayed).not.toHaveBeenCalled();

      transaction.mockClear();
      transaction.mockRejectedValueOnce(deadlock).mockRejectedValueOnce(wrappedDeadlock).mockRejectedValueOnce(deadlock);
      const failedAccepted = vi.fn();
      const failedReplay = vi.fn();
      await expect(persist(source.conversationId, source.orgId, "Exhausted send", null, {
        clientMutationId: `send:${randomUUID()}`,
        onTransactionCommitted: failedAccepted,
        onIdempotentReplay: failedReplay,
      })).rejects.toBe(deadlock);
      expect(transaction).toHaveBeenCalledTimes(3);
      expect(failedAccepted).not.toHaveBeenCalled();
      expect(failedReplay).not.toHaveBeenCalled();
    } finally {
      transaction.mockRestore();
    }
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

  it("validates Process annotations from top-level Run Reader fields without legacy transcript rows", async () => {
    const source = await seedSource({ body: "Final answer" });
    const evidence = await seedProcessEvidence({
      source,
      text: "Reader-backed process evidence",
    });
    const readerEntry = {
      kind: "thinking",
      ts: "2026-07-23T10:00:00.000Z",
      text: evidence.text,
      delta: true,
      sourceEntryId: `message:${source.sourceMessageId}:0`,
      payload: {
        kind: "assistant",
        ts: "2026-07-23T09:59:00.000Z",
        text: "Payload text must not replace Reader text",
        generationId: evidence.generationId,
        generationSeqStart: 1,
        generationSeqEnd: 1,
      },
    } satisfies Extract<TranscriptEntry, { kind: "thinking" }> & { payload: Record<string, unknown> };
    const run = await seedRunReaderTranscript(source, [readerEntry]);
    await db.update(chatMessages).set({ runId: run.runId })
      .where(eq(chatMessages.id, source.sourceMessageId));
    expect(await db.select().from(chatMessageTranscriptEntries)
      .where(eq(chatMessageTranscriptEntries.orgId, source.orgId))).toEqual([]);
    expect(await db.select().from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, run.runId))).toEqual([]);

    await expect(service.prepare({
      orgId: source.orgId,
      conversationId: source.conversationId,
      uploadedFileCount: 0,
      annotations: [{
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
      }],
    })).resolves.toMatchObject({
      annotations: [expect.objectContaining({
        sourceMessageId: source.sourceMessageId,
        generationId: evidence.generationId,
        selectedText: evidence.text,
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
