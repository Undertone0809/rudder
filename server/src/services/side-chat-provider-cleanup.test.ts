import {
  activityLog,
  agents,
  applyPendingMigrations,
  chatConversations,
  createDb,
  ensurePostgresDatabase,
  nativeSegments,
  organizations,
  runtimeBindings,
  runtimeRetentionClaims,
  runtimeSourceAliases,
  sideChatProviderCleanupIntents,
  type Db,
} from "@rudderhq/db";
import { deriveOrganizationUrlKey } from "@rudderhq/shared";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  persistSideChatProviderCleanupIntents,
  sideChatProviderCleanupService,
} from "./side-chat-provider-cleanup.js";

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

async function startTempDatabase() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-side-chat-cleanup-"));
  const port = await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate test port")));
        return;
      }
      const { port: availablePort } = address;
      server.close((error) => error ? reject(error) : resolve(availablePort));
    });
  });
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

  const adminConnectionString = `postgres://rudder:rudder@127.0.0.1:${port}/postgres`;
  await ensurePostgresDatabase(adminConnectionString, "rudder");
  const connectionString = `postgres://rudder:rudder@127.0.0.1:${port}/rudder`;
  await applyPendingMigrations(connectionString);
  return { connectionString, dataDir, instance };
}

type CleanupFixture = {
  orgId: string;
  conversationId: string;
  bindingId: string;
  segmentIds: [string, string];
};
type CleanupTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

describe("Side Chat provider cleanup service", () => {
  let db!: ReturnType<typeof createDb>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(agents);
    await db.delete(organizations);
  });

  afterAll(async () => {
    await db?.$client.end();
    await instance?.stop();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function createFixture(runtimeType = "codex_local"): Promise<CleanupFixture> {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const conversationId = randomUUID();
    const bindingId = randomUUID();
    const segmentIds: [string, string] = [randomUUID(), randomUUID()];
    const name = `Cleanup ${randomUUID()}`;
    await db.insert(organizations).values({
      id: orgId,
      name,
      urlKey: deriveOrganizationUrlKey(name),
      issuePrefix: `S${randomUUID().replaceAll("-", "").slice(0, 7).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Side Chat Agent",
      role: "engineer",
      status: "active",
      agentRuntimeType: runtimeType,
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      conversationKind: "side_chat",
      messengerVisible: false,
      sideChatState: "active",
      createdByUserId: "side-chat-owner",
    });
    await db.insert(runtimeBindings).values({
      id: bindingId,
      orgId,
      conversationId,
      principalScopeRef: "user:side-chat-owner",
      agentId,
      runtimeType,
      hostId: "local-host",
      profileId: "default-profile",
      instructionsRevision: "instructions-v1",
      capabilityRevision: "capabilities-v1",
      continuity: "native",
      sourceBoundaryRef: "source-boundary-opaque",
      bindingEpoch: 0,
    });
    await db.insert(nativeSegments).values(segmentIds.map((id, segmentOrdinal) => ({
      id,
      orgId,
      bindingId,
      runtimeType,
      segmentOrdinal,
      nativeSessionId: "provider-session-opaque",
      rootSessionId: "provider-root-opaque",
      sourceBoundaryRef: `segment-boundary-${segmentOrdinal}`,
      leafId: `provider-leaf-${segmentOrdinal}`,
      state: "open" as const,
    })));
    return { orgId, conversationId, bindingId, segmentIds };
  }

  async function persistAndDestroy(fixture: CleanupFixture) {
    const now = new Date("2026-09-24T00:00:00.000Z");
    await db.transaction((tx) => persistSideChatProviderCleanupIntents(tx as unknown as Db, {
      id: fixture.conversationId,
      orgId: fixture.orgId,
      createdByUserId: "side-chat-owner",
      sideChatState: "active",
      messengerVisible: false,
    }, now));
    await db.delete(chatConversations).where(eq(chatConversations.id, fixture.conversationId));
    const [intent] = await db.select().from(sideChatProviderCleanupIntents)
      .where(eq(sideChatProviderCleanupIntents.orgId, fixture.orgId));
    expect(intent).toBeDefined();
    return intent!;
  }

  async function writeRetryAudit(tx: CleanupTransaction, orgId: string, intentId: string) {
    await tx.insert(activityLog).values({
      orgId,
      actorType: "user",
      actorId: "operator-1",
      action: "side_chat.provider_cleanup_retry_requested",
      entityType: "side_chat_provider_cleanup_intent",
      entityId: intentId,
    });
  }

  it.each([
    {
      kind: "retention claim",
      ref: "opaque-retention-reference-not-derived-from-session",
      reason: "provider_resource_has_an_active_retention_claim",
      snapshotKey: "retentionResourceRefs" as const,
    },
    {
      kind: "source alias",
      ref: "opaque-source-reference-not-derived-from-session",
      reason: "provider_resource_has_an_active_source_alias",
      snapshotKey: "sourceAliasRefs" as const,
    },
  ])("preserves and rechecks an opaque $kind on a non-selected segment after Side Chat destruction", async ({
    kind,
    ref,
    reason,
    snapshotKey,
  }) => {
    const fixture = await createFixture();
    const unselectedSegmentId = fixture.segmentIds[1];
    if (kind === "retention claim") {
      await db.insert(runtimeRetentionClaims).values({
        orgId: fixture.orgId,
        segmentId: unselectedSegmentId,
        resourceRef: ref,
        purpose: "side_chat_test",
        principalScopeRef: "user:side-chat-owner",
      });
    } else {
      await db.insert(runtimeSourceAliases).values({
        orgId: fixture.orgId,
        segmentId: unselectedSegmentId,
        sourceKind: "side_chat_test",
        sourceRef: ref,
        principalScopeRef: "user:side-chat-owner",
      });
    }

    const intent = await persistAndDestroy(fixture);
    expect(intent.segmentId).not.toBe(unselectedSegmentId);
    expect(intent.protectionRefsJson.segmentIds).toEqual(expect.arrayContaining(fixture.segmentIds));
    expect(intent.protectionRefsJson[snapshotKey]).toContain(ref);
    if (kind === "retention claim") {
      await expect(db.select({ segmentId: runtimeRetentionClaims.segmentId })
        .from(runtimeRetentionClaims)
        .where(eq(runtimeRetentionClaims.resourceRef, ref)))
        .resolves.toEqual([{ segmentId: null }]);
    } else {
      await expect(db.select({ segmentId: runtimeSourceAliases.segmentId })
        .from(runtimeSourceAliases)
        .where(eq(runtimeSourceAliases.sourceRef, ref)))
        .resolves.toEqual([{ segmentId: null }]);
    }

    const resolveDriver = vi.fn(() => null);
    const service = sideChatProviderCleanupService(db, {
      workerId: `cleanup-worker-${fixture.orgId}`,
      now: () => new Date("2026-09-24T00:01:00.000Z"),
      resolveDriver,
    });
    await service.retryReviewRequired({ orgId: fixture.orgId, intentId: intent.id });
    const [retryAudit] = await db.select().from(activityLog).where(eq(activityLog.entityId, intent.id));
    expect(retryAudit).toMatchObject({
      orgId: fixture.orgId,
      actorType: "system",
      actorId: "side_chat_provider_cleanup_service",
      action: "side_chat.provider_cleanup_retry_requested",
      entityType: "side_chat_provider_cleanup_intent",
      details: { state: "pending", source: "service" },
    });
    await expect(service.processBatch(1)).resolves.toBe(1);

    const [retried] = await db.select().from(sideChatProviderCleanupIntents)
      .where(eq(sideChatProviderCleanupIntents.id, intent.id));
    expect(retried).toMatchObject({ state: "review_required", stateReason: reason, completedAt: null });
    expect(resolveDriver).not.toHaveBeenCalled();
  });

  it("keeps OpenCode cleanup in audited review instead of falsely completing a retry", async () => {
    const fixture = await createFixture("opencode_local");
    const intent = await persistAndDestroy(fixture);
    expect(intent.stateReason).toBe("provider_fork_delete_mutual_exclusion_is_process_local");

    const resolveDriver = vi.fn(() => null);
    const service = sideChatProviderCleanupService(db, {
      workerId: `opencode-cleanup-worker-${fixture.orgId}`,
      now: () => new Date("2026-09-24T00:01:00.000Z"),
      resolveDriver,
    });
    await service.retryReviewRequired(
      { orgId: fixture.orgId, intentId: intent.id },
      (tx) => writeRetryAudit(tx, fixture.orgId, intent.id),
    );
    await expect(service.processBatch(1)).resolves.toBe(1);

    const [retried] = await db.select().from(sideChatProviderCleanupIntents)
      .where(eq(sideChatProviderCleanupIntents.id, intent.id));
    expect(retried).toMatchObject({
      state: "review_required",
      stateReason: "provider_fork_delete_mutual_exclusion_is_process_local",
      completedAt: null,
    });
    expect(resolveDriver).not.toHaveBeenCalled();
  });

  it("rolls back a review retry when the audit write fails", async () => {
    const fixture = await createFixture();
    const intent = await persistAndDestroy(fixture);
    const service = sideChatProviderCleanupService(db);
    const auditFailure = new Error("audit storage unavailable");

    await expect(service.retryReviewRequired({ orgId: fixture.orgId, intentId: intent.id }, async (tx) => {
      await tx.insert(activityLog).values({
        orgId: fixture.orgId,
        actorType: "user",
        actorId: "operator-1",
        action: "side_chat.provider_cleanup_retry_requested",
        entityType: "side_chat_provider_cleanup_intent",
        entityId: intent.id,
      });
      throw auditFailure;
    })).rejects.toBe(auditFailure);

    const [afterFailure] = await db.select().from(sideChatProviderCleanupIntents)
      .where(eq(sideChatProviderCleanupIntents.id, intent.id));
    expect(afterFailure).toMatchObject({ state: "review_required", stateReason: intent.stateReason });
    await expect(db.select({ id: activityLog.id }).from(activityLog)
      .where(eq(activityLog.entityId, intent.id))).resolves.toEqual([]);
  });
});
