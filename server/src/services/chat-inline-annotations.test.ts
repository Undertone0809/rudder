import {
  applyPendingMigrations,
  assets,
  chatAttachments,
  chatConversations,
  chatGenerationEvents,
  chatGenerations,
  chatMessages,
  createDb,
  ensurePostgresDatabase,
  organizations,
} from "@rudderhq/db";
import type { ChatInlineAnnotationInput } from "@rudderhq/shared";
import { eq } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  bindPreparedChatInlineAnnotationFiles,
  chatInlineAnnotationService,
} from "./chat-inline-annotations.js";

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

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    service = chatInlineAnnotationService(db);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 30_000);

  afterEach(async () => {
    await db.delete(chatGenerationEvents);
    await db.delete(chatGenerations);
    await db.delete(chatAttachments);
    await db.delete(assets);
    await db.delete(chatMessages);
    await db.delete(chatConversations);
    await db.delete(organizations);
  });

  afterAll(async () => {
    await instance?.stop();
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
    overrides: Partial<ChatInlineAnnotationInput> = {},
  ): ChatInlineAnnotationInput {
    const start = body.indexOf("[the docs]");
    const end = body.indexOf(" before shipping.");
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

  async function seedProcessEvidence(input: {
    source: Awaited<ReturnType<typeof seedSource>>;
    text?: string;
    entryOverrides?: Record<string, unknown>;
    projectToVisibleMessage?: boolean;
  }) {
    const generationId = randomUUID();
    const text = input.text ?? "Inspect";
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
          kind: "thinking",
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
            kind: "thinking",
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

  it("accepts rendered assistant selections across links, inline code, CJK, entities, whitespace, and blocks", async () => {
    const body = [
      "## 说明",
      "",
      "阅读 [中文文档](https://example.test/docs) 与 `npm test` &amp; verify.",
      "",
      "Second block.",
    ].join("\n");
    const source = await seedSource({ body });
    const start = body.indexOf("[中文文档]");
    const end = body.indexOf("Second block.") + "Second block.".length;

    await expect(service.prepare({
      orgId: source.orgId,
      conversationId: source.conversationId,
      uploadedFileCount: 0,
      annotations: [{
        id: randomUUID(),
        surface: "assistant_body",
        selectedText: "中文文档 与 npm test & verify. Second block.",
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
        selectedText: "中文文档 与 npm test & verify. Second block.",
      })],
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
      selectedText: "the docs before editing",
      comment: null,
      sourceConversationId: source.conversationId,
      sourceMessageId: source.sourceMessageId,
      sourceHash: sha256(processSource),
      generationId,
      generationSeqStart: 1,
      generationSeqEnd: 2,
      start: 0,
      end: processSource.length,
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
        generationId,
        generationSeqStart: 1,
        generationSeqEnd: 2,
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
        selectedText: "中文文档 与 npm test & verify. Second block.",
        comment: null,
        sourceConversationId: source.conversationId,
        sourceMessageId: source.sourceMessageId,
        sourceHash: sha256(processSource),
        generationId: evidence.generationId,
        generationSeqStart: 1,
        generationSeqEnd: 1,
        start: processSource.indexOf("[中文文档]"),
        end: processSource.length,
        prefix: processSource.slice(0, processSource.indexOf("[中文文档]")),
        suffix: "",
        attachmentIds: [],
      }],
    })).resolves.toMatchObject({
      annotations: [expect.objectContaining({
        selectedText: "中文文档 与 npm test & verify. Second block.",
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
