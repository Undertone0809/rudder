import {
  agents,
  applyPendingMigrations,
  chatConversations,
  createDb,
  ensurePostgresDatabase,
  heartbeatRuns,
  nativeSegments,
  organizations,
  runRuntimeSpans,
  runtimeBindings,
  runtimeRetentionClaims,
  runtimeSourceAliases,
} from "@rudderhq/db";
import { deriveOrganizationUrlKey } from "@rudderhq/shared";
import { and, eq, inArray } from "drizzle-orm";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { attachRuntimeSpanSupplement } from "./native-session.js";
import {
  EXPIRED_SIDE_CHAT_TRANSCRIPT_RETENTION_MS,
  runRuntimeRetentionMaintenance,
  runtimeRetentionService,
  startRuntimeRetentionMaintenance,
} from "./runtime-retention.js";
import {
  createTranscriptObjectReader,
  createTranscriptObjectStore,
  type TranscriptObjectStore,
} from "./transcript-object-store.js";

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

async function availablePort() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate a PostgreSQL port")));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function startTempDatabase() {
  const external = process.env.RUDDER_RUNTIME_RETENTION_TEST_DATABASE_URL?.trim();
  if (external) {
    await applyPendingMigrations(external);
    return { connectionString: external, dataDir: "", instance: null };
  }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-runtime-retention-"));
  const port = await availablePort();
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

describe("runtime retention service", () => {
  let db!: ReturnType<typeof createDb>;
  let service!: ReturnType<typeof runtimeRetentionService>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";
  const createdOrgIds = new Set<string>();
  const createdObjectRoots = new Set<string>();

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    service = runtimeRetentionService(db);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 60_000);

  afterEach(async () => {
    for (const root of createdObjectRoots) fs.rmSync(root, { recursive: true, force: true });
    createdObjectRoots.clear();
    const orgIds = [...createdOrgIds];
    createdOrgIds.clear();
    if (orgIds.length === 0) return;
    const where = inArray(organizations.id, orgIds);
    await db.delete(runtimeSourceAliases).where(inArray(runtimeSourceAliases.orgId, orgIds));
    await db.delete(runtimeRetentionClaims).where(inArray(runtimeRetentionClaims.orgId, orgIds));
    // These fixtures insert spans directly and never launch a provider writer.
    // Release only this test's synthetic leases after its retention assertions.
    await db.update(runRuntimeSpans).set({
      state: "unresolved", completeness: "unknown", closedAt: new Date(),
      writerLeaseReleasedAt: new Date(),
    })
      .where(inArray(runRuntimeSpans.orgId, orgIds));
    await db.delete(runRuntimeSpans).where(inArray(runRuntimeSpans.orgId, orgIds));
    await db.delete(nativeSegments).where(inArray(nativeSegments.orgId, orgIds));
    await db.delete(runtimeBindings).where(inArray(runtimeBindings.orgId, orgIds));
    await db.delete(heartbeatRuns).where(inArray(heartbeatRuns.orgId, orgIds));
    await db.delete(chatConversations).where(inArray(chatConversations.orgId, orgIds));
    await db.delete(agents).where(inArray(agents.orgId, orgIds));
    await db.delete(organizations).where(where);
  });

  afterAll(async () => {
    await instance?.stop();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function createOrg() {
    const id = crypto.randomUUID();
    createdOrgIds.add(id);
    await db.insert(organizations).values({
      id,
      name: `Retention ${id}`,
      urlKey: deriveOrganizationUrlKey(`retention-${id}`),
      issuePrefix: `RT${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return id;
  }

  function createObjectStore() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-runtime-retention-object-"));
    createdObjectRoots.add(root);
    return { root, store: createTranscriptObjectStore(root) };
  }

  it("is idempotent, promotes a Side Chat claim in place, and never creates a Run", async () => {
    const orgId = await createOrg();
    const purpose = "side_chat:keep-in-place";
    const resourceRef = "chat:keep-in-place";
    const principalScopeRef = "user:owner";
    const firstExpiry = new Date(Date.now() + 60_000);
    const laterExpiry = new Date(Date.now() + 120_000);

    const [first] = await service.ensureClaims({
      orgId,
      claims: [{ resourceRef, purpose, principalScopeRef, expiresAt: firstExpiry }],
    });
    const [second] = await service.ensureClaims({
      orgId,
      claims: [{ resourceRef, purpose, principalScopeRef, expiresAt: laterExpiry }],
    });
    expect(second?.id).toBe(first?.id);

    const promoted = await service.promoteClaims({ orgId, purpose, principalScopeRef });
    expect(promoted).toHaveLength(1);
    expect(promoted[0]).toMatchObject({ id: first?.id, status: "active", expiresAt: null });
    const repeatedKeep = await service.promoteClaims({ orgId, purpose, principalScopeRef });
    expect(repeatedKeep).toHaveLength(1);
    expect(repeatedKeep[0]?.id).toBe(first?.id);

    const rows = await db.select().from(runtimeRetentionClaims).where(eq(runtimeRetentionClaims.orgId, orgId));
    expect(rows).toHaveLength(1);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.orgId, orgId))).toHaveLength(0);
  });

  it("expires and releases only the matching purpose and principal", async () => {
    const orgId = await createOrg();
    const target = {
      resourceRef: "chat:target",
      purpose: "side_chat:target",
      principalScopeRef: "user:owner",
    };
    const sibling = {
      resourceRef: "chat:sibling",
      purpose: "side_chat:sibling",
      principalScopeRef: "user:other",
    };
    await service.ensureClaims({
      orgId,
      claims: [
        { ...target, expiresAt: new Date(Date.now() + 60_000) },
        { ...sibling, expiresAt: new Date(Date.now() + 60_000) },
      ],
    });

    await service.expireClaims({
      orgId,
      purpose: target.purpose,
      principalScopeRef: "user:not-owner",
      force: true,
    });
    let rows = await db.select().from(runtimeRetentionClaims).where(eq(runtimeRetentionClaims.orgId, orgId));
    expect(rows.every((row) => row.status === "active")).toBe(true);

    await service.expireClaims({
      orgId,
      purpose: target.purpose,
      principalScopeRef: target.principalScopeRef,
      force: true,
    });
    rows = await db.select().from(runtimeRetentionClaims).where(eq(runtimeRetentionClaims.orgId, orgId));
    expect(rows.find((row) => row.purpose === target.purpose)?.status).toBe("expired");
    expect(rows.find((row) => row.purpose === sibling.purpose)?.status).toBe("active");
  });

  it("checks parent and child resource claims before declaring a resource collectable", async () => {
    const orgId = await createOrg();
    const now = new Date();
    await service.ensureClaims({
      orgId,
      claims: [
        {
          resourceRef: "native:parent",
          purpose: "side_chat:temporary",
          principalScopeRef: "user:owner",
          expiresAt: new Date(now.getTime() + 1_000),
        },
        {
          resourceRef: "native:child",
          purpose: "side_chat:temporary",
          principalScopeRef: "user:owner",
          expiresAt: new Date(now.getTime() + 1_000),
        },
      ],
    });

    const expired = await service.gcExpired({
      orgId,
      resourceRefs: ["native:parent", "native:child"],
      now: new Date(now.getTime() + 2_000),
    });
    expect(expired).toMatchObject({ status: "collectable", collectable: true });
    expect(expired.expiredClaimIds).toHaveLength(2);

    await service.ensureClaims({
      orgId,
      claims: [{
        resourceRef: "native:child",
        purpose: "side_chat:kept",
        principalScopeRef: "user:owner",
        expiresAt: null,
      }],
    });
    const blocked = await service.gcExpired({
      orgId,
      resourceRefs: ["native:parent", "native:child"],
      now: new Date(now.getTime() + 3_000),
    });
    expect(blocked).toMatchObject({ status: "blocked", collectable: false, blockedBy: "claim" });
  });

  it("fences a stale GC attempt after Keep changes the claim epoch", async () => {
    const orgId = await createOrg();
    const [claim] = await service.ensureClaims({
      orgId,
      claims: [{
        resourceRef: "native:fenced",
        purpose: "side_chat:fenced",
        principalScopeRef: "user:owner",
        expiresAt: new Date(Date.now() + 60_000),
      }],
    });
    const oldFence = {
      id: claim!.id,
      lifecycleVersion: claim!.lifecycleVersion,
      cleanupEpoch: claim!.cleanupEpoch,
    };
    await service.promoteClaims({
      orgId,
      purpose: "side_chat:fenced",
      principalScopeRef: "user:owner",
    });

    const result = await service.gcExpired({
      orgId,
      resourceRefs: ["native:fenced"],
      now: new Date(Date.now() + 120_000),
      expectedFences: [oldFence],
    });
    expect(result).toMatchObject({ status: "fenced", collectable: false });
    const [persisted] = await db.select().from(runtimeRetentionClaims).where(eq(runtimeRetentionClaims.id, claim!.id));
    expect(persisted).toMatchObject({ status: "active", expiresAt: null });
  });

  it("blocks collection for a live span and releases an expired source alias without deleting provider state", async () => {
    const orgId = await createOrg();
    const agentId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    const bindingId = crypto.randomUUID();
    const segmentId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const spanId = crypto.randomUUID();
    await db.insert(agents).values({ id: agentId, orgId, name: "Retention agent", role: "engineer" });
    await db.insert(chatConversations).values({ id: conversationId, orgId, title: "Retention chat" });
    await db.insert(runtimeBindings).values({
      id: bindingId,
      orgId,
      conversationId,
      principalScopeRef: "user:owner",
      agentId,
      runtimeType: "codex_local",
      instructionsRevision: "instructions-1",
      capabilityRevision: "capability-1",
      continuity: "native",
    });
    await db.insert(nativeSegments).values({
      id: segmentId,
      orgId,
      bindingId,
      runtimeType: "codex_local",
      state: "open",
      segmentOrdinal: 0,
    });
    await db.insert(heartbeatRuns).values({ id: runId, orgId, agentId, status: "running" });
    await db.insert(runRuntimeSpans).values({
      id: spanId,
      orgId,
      runId,
      bindingId,
      segmentId,
      attemptRef: "attempt-1",
      ownerToken: "owner-1",
      state: "open",
      supplementalObjectRef: "tobj_v1_11111111-1111-1111-1111-111111111111",
    });
    await service.ensureClaims({
      orgId,
      claims: [{
        resourceRef: "native:live",
        purpose: "side_chat:live",
        principalScopeRef: "user:owner",
        bindingId,
        segmentId,
        expiresAt: null,
      }],
    });
    const gcNow = new Date(Date.now() + 2_000);
    await service.ensureClaims({
      orgId,
      claims: [{
        resourceRef: "native:expired-claim",
        purpose: "side_chat:expired-claim",
        principalScopeRef: "user:owner",
        bindingId,
        segmentId,
        expiresAt: new Date(gcNow.getTime() - 1_000),
      }],
    });
    await service.ensureSourceAlias({
      orgId,
      alias: {
        sourceKind: "native_segment",
        sourceRef: "native:expired-alias",
        principalScopeRef: "user:owner",
        runId,
        segmentId,
        expiresAt: new Date(gcNow.getTime() - 1_000),
      },
    });

    const blocked = await service.inspect({ orgId, resourceRefs: ["native:live"] });
    expect(blocked).toMatchObject({ collectable: false, blockedBy: "claim", inFlightSpanIds: [spanId], inFlightRunIds: [runId] });
    const directObjectBlocked = await service.inspect({
      orgId,
      resourceRefs: ["tobj_v1_11111111-1111-1111-1111-111111111111"],
    });
    expect(directObjectBlocked).toMatchObject({
      collectable: false,
      blockedBy: "in_flight",
      inFlightSpanIds: [spanId],
      inFlightRunIds: [runId],
    });
    const aliasGc = await service.gcExpired({
      orgId,
      resourceRefs: ["native:expired-alias"],
      now: gcNow,
    });
    expect(aliasGc).toMatchObject({
      status: "blocked",
      collectable: false,
      blockedBy: "in_flight",
      expiredClaimIds: [],
      releasedAliasIds: [],
      inFlightSpanIds: [spanId],
      inFlightRunIds: [runId],
    });

    const claimGc = await service.gcExpired({
      orgId,
      resourceRefs: ["native:expired-claim"],
      now: gcNow,
    });
    expect(claimGc).toMatchObject({
      status: "blocked",
      collectable: false,
      expiredClaimIds: [],
      inFlightSpanIds: [spanId],
      inFlightRunIds: [runId],
    });
    const [uncollectedClaim] = await db.select().from(runtimeRetentionClaims).where(and(
      eq(runtimeRetentionClaims.orgId, orgId),
      eq(runtimeRetentionClaims.resourceRef, "native:expired-claim"),
    ));
    expect(uncollectedClaim?.status).toBe("active");

    await service.releaseClaims({ orgId, purpose: "side_chat:live", principalScopeRef: "user:owner" });
    const stillInFlight = await service.inspect({ orgId, resourceRefs: ["native:live"] });
    expect(stillInFlight).toMatchObject({ collectable: false, blockedBy: "in_flight" });
    await db.update(runRuntimeSpans).set({ state: "sealed", closedAt: new Date() }).where(and(
      eq(runRuntimeSpans.id, spanId),
      eq(runRuntimeSpans.orgId, orgId),
    ));
    await db.update(heartbeatRuns).set({ status: "completed" }).where(and(
      eq(heartbeatRuns.id, runId),
      eq(heartbeatRuns.orgId, orgId),
    ));
    await db.update(chatConversations).set({ sideChatState: "kept" }).where(and(
      eq(chatConversations.id, conversationId),
      eq(chatConversations.orgId, orgId),
    ));
    const keptChat = await service.inspect({
      orgId,
      resourceRefs: ["tobj_v1_11111111-1111-1111-1111-111111111111"],
    });
    expect(keptChat).toMatchObject({ collectable: false, blockedBy: "kept_chat", keptConversationIds: [conversationId] });
    await db.update(chatConversations).set({ sideChatState: "expired" }).where(and(
      eq(chatConversations.id, conversationId),
      eq(chatConversations.orgId, orgId),
    ));
    await service.ensureSourceAlias({
      orgId,
      alias: {
        sourceKind: "transcript_object",
        sourceRef: "tobj_v1_11111111-1111-1111-1111-111111111111",
        principalScopeRef: "user:owner",
        runId,
        segmentId,
        expiresAt: null,
      },
    });
    const readerReference = await service.inspect({
      orgId,
      resourceRefs: ["tobj_v1_11111111-1111-1111-1111-111111111111"],
    });
    expect(readerReference).toMatchObject({ collectable: false, blockedBy: "source_alias" });
    await service.releaseSourceAliases({
      orgId,
      principalScopeRef: "user:owner",
      sourceRefs: ["tobj_v1_11111111-1111-1111-1111-111111111111"],
    });
    const collectedClaim = await service.gcExpired({
      orgId,
      resourceRefs: ["native:expired-claim"],
      now: gcNow,
    });
    expect(collectedClaim).toMatchObject({ status: "collectable", collectable: true });
    expect(collectedClaim.expiredClaimIds).toHaveLength(1);
    const collectedAlias = await service.gcExpired({
      orgId,
      resourceRefs: ["native:expired-alias"],
      now: gcNow,
    });
    expect(collectedAlias).toMatchObject({ status: "collectable", collectable: true });
    expect(collectedAlias.releasedAliasIds).toHaveLength(1);
    const collectable = await service.inspect({ orgId, resourceRefs: ["native:live"] });
    expect(collectable).toMatchObject({ collectable: true, blockedBy: null });
  });

  it("expires and collects an unreferenced claim and object in one maintenance tick", async () => {
    const orgId = await createOrg();
    const { root, store } = createObjectStore();
    const runId = crypto.randomUUID();
    const spanId = crypto.randomUUID();
    const objectRef = await store.write({
      orgId,
      runId,
      spanId,
      ownerToken: "maintenance-owner",
      entries: [{ kind: "assistant", ts: "2026-09-22T00:00:00.000Z", text: "expired" }],
    });
    const createdAt = new Date();
    const now = new Date(createdAt.getTime() + 60_000);
    await service.ensureClaims({
      orgId,
      claims: [{
        resourceRef: objectRef,
        purpose: "transcript:temporary",
        principalScopeRef: "system:maintenance",
        expiresAt: new Date(createdAt.getTime() + 1_000),
      }],
    });

    const result = await runRuntimeRetentionMaintenance(db, {
      objectStore: store,
      now,
      objectGraceMs: 0,
    });
    expect(result).toMatchObject({
      organizationCount: 1,
      expiredClaimCount: 1,
      deletedClaimCount: 1,
      objectSweep: { deletedObjectRefs: [objectRef] },
    });
    expect(await db.select().from(runtimeRetentionClaims).where(eq(runtimeRetentionClaims.orgId, orgId))).toHaveLength(0);
    expect(fs.existsSync(path.join(root, "transcript-objects", `${objectRef}.json`))).toBe(false);
  });

  it("preserves missing-payload metadata without a matching marked span", async () => {
    const orgId = await createOrg();
    const { root, store } = createObjectStore();
    const runId = crypto.randomUUID();
    const spanId = crypto.randomUUID();
    const objectRef = await store.write({
      orgId,
      runId,
      spanId,
      ownerToken: "incomplete-owner",
      entries: [{ kind: "assistant", ts: "2026-09-23T00:00:00.000Z", text: "incomplete" }],
    });
    const objectDir = path.join(root, "transcript-objects");
    const metadataPath = path.join(objectDir, `${objectRef}.json`);
    const payloadPath = path.join(objectDir, `${objectRef}.ndjson`);
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
    metadata.updatedAt = new Date(Date.now() - 60_000).toISOString();
    fs.writeFileSync(metadataPath, `${JSON.stringify(metadata)}\n`, "utf8");
    await fs.promises.rm(payloadPath);

    const result = await runRuntimeRetentionMaintenance(db, {
      objectStore: store,
      now: new Date(Date.now() + 1_000),
      objectGraceMs: 0,
    });

    expect(result.objectSweep).toMatchObject({ skipped: 1, deletedObjectRefs: [] });
    expect(fs.existsSync(metadataPath)).toBe(true);
    expect(fs.existsSync(payloadPath)).toBe(false);
  });

  it("pins an attached Reader transcript for a durable chat after its claim expires", async () => {
    const orgId = await createOrg();
    const { store, root } = createObjectStore();
    const agentId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    const bindingId = crypto.randomUUID();
    const segmentId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const spanId = crypto.randomUUID();
    const ownerToken = "attached-reader-owner";
    const objectRef = await store.write({
      orgId,
      runId,
      spanId,
      ownerToken,
      entries: [{ kind: "assistant", ts: "2026-09-23T00:00:00.000Z", text: "still readable" }],
    });
    await db.insert(agents).values({ id: agentId, orgId, name: "Retention agent", role: "engineer" });
    await db.insert(chatConversations).values({ id: conversationId, orgId, title: "Reader transcript" });
    await db.insert(runtimeBindings).values({
      id: bindingId,
      orgId,
      conversationId,
      principalScopeRef: "user:owner",
      agentId,
      runtimeType: "codex_local",
      instructionsRevision: "instructions-1",
      capabilityRevision: "capability-1",
      continuity: "native",
    });
    await db.insert(nativeSegments).values({
      id: segmentId,
      orgId,
      bindingId,
      runtimeType: "codex_local",
      state: "open",
      segmentOrdinal: 0,
    });
    await db.insert(heartbeatRuns).values({ id: runId, orgId, agentId, status: "completed" });
    await db.insert(runRuntimeSpans).values({
      id: spanId,
      orgId,
      runId,
      bindingId,
      segmentId,
      attemptRef: "attempt-1",
      ownerToken,
      state: "sealed",
      closedAt: new Date(Date.now() + 60_000),
      supplementalObjectRef: objectRef,
    });
    const now = new Date(Date.now() + 10_000);
    await service.ensureClaims({
      orgId,
      claims: [{
        resourceRef: objectRef,
        purpose: "transcript:temporary",
        principalScopeRef: "system:maintenance",
        expiresAt: new Date(now.getTime() - 1_000),
      }],
    });

    const result = await runRuntimeRetentionMaintenance(db, { objectStore: store, now, objectGraceMs: 0 });
    expect(result).toMatchObject({
      expiredClaimCount: 1,
      deletedClaimCount: 1,
      objectSweep: { protected: 1, deletedObjectRefs: [] },
    });
    expect(fs.existsSync(path.join(root, "transcript-objects", `${objectRef}.json`))).toBe(true);
    const reader = createTranscriptObjectReader(store);
    const readInput = {
      readonly: true,
      scope: "run",
      orgId,
      run: { id: runId },
      span: { id: spanId, ownerToken, supplementalObjectRef: objectRef },
    } as unknown as import("./transcript-reader.js").NativeTranscriptReadInput;
    await expect(reader.readRange!(readInput)).resolves.toMatchObject({
      availability: "available",
      entries: [expect.objectContaining({ text: "still readable" })],
    });
  });

  it("retains an expired Side Chat transcript through its grace window, then detaches it", async () => {
    const orgId = await createOrg();
    const { store, root } = createObjectStore();
    const agentId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    const bindingId = crypto.randomUUID();
    const segmentId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const spanId = crypto.randomUUID();
    const expiredAt = new Date("2026-09-01T00:00:00.000Z");
    const objectRef = await store.write({
      orgId, runId, spanId, ownerToken: "temporary-owner",
      entries: [{ kind: "assistant", ts: expiredAt.toISOString(), text: "temporary transcript" }],
    });
    const metadataPath = path.join(root, "transcript-objects", `${objectRef}.json`);
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
    metadata.updatedAt = expiredAt.toISOString();
    fs.writeFileSync(metadataPath, `${JSON.stringify(metadata)}\n`, "utf8");
    await db.insert(agents).values({ id: agentId, orgId, name: "Temporary agent", role: "engineer" });
    await db.insert(chatConversations).values({
      id: conversationId, orgId, title: "Expired Side Chat",
      conversationKind: "side_chat", sideChatState: "active", sideChatExpiresAt: expiredAt,
    });
    await db.insert(runtimeBindings).values({
      id: bindingId, orgId, conversationId, principalScopeRef: "user:owner", agentId,
      runtimeType: "cursor_local", instructionsRevision: "instructions-1",
      capabilityRevision: "capability-1", continuity: "native",
    });
    await db.insert(nativeSegments).values({
      id: segmentId, orgId, bindingId, runtimeType: "cursor_local", state: "open", segmentOrdinal: 0,
    });
    await db.insert(heartbeatRuns).values({
      id: runId, orgId, agentId, status: "completed", finishedAt: expiredAt,
    });
    await db.insert(runRuntimeSpans).values({
      id: spanId, orgId, runId, bindingId, segmentId, attemptRef: "attempt-1",
      ownerToken: "temporary-owner", state: "sealed", openedAt: expiredAt, closedAt: expiredAt,
      supplementalObjectRef: objectRef,
    });

    const beforeGrace = await runRuntimeRetentionMaintenance(db, {
      objectStore: store,
      now: new Date(expiredAt.getTime() + EXPIRED_SIDE_CHAT_TRANSCRIPT_RETENTION_MS - 1),
      objectGraceMs: 0,
    });
    expect(beforeGrace.objectSweep).toMatchObject({ protected: 1, deletedObjectRefs: [] });
    expect(fs.existsSync(metadataPath)).toBe(true);

    await db.update(heartbeatRuns).set({ status: "running", finishedAt: null }).where(eq(heartbeatRuns.id, runId));
    const lateFinish = new Date(expiredAt.getTime() + EXPIRED_SIDE_CHAT_TRANSCRIPT_RETENTION_MS + 24 * 60 * 60 * 1000);
    const whileRunning = await runRuntimeRetentionMaintenance(db, {
      objectStore: store,
      now: lateFinish,
      objectGraceMs: 0,
    });
    expect(whileRunning.objectSweep).toMatchObject({ protected: 1, deletedObjectRefs: [] });
    await db.update(heartbeatRuns).set({ status: "completed", finishedAt: lateFinish }).where(eq(heartbeatRuns.id, runId));
    await db.update(runRuntimeSpans).set({ closedAt: lateFinish }).where(eq(runRuntimeSpans.id, spanId));
    await db.update(chatConversations).set({
      sideChatState: "expired", sideChatExpiresAt: null, updatedAt: expiredAt,
    }).where(eq(chatConversations.id, conversationId));

    const afterExpiryGrace = await runRuntimeRetentionMaintenance(db, {
      objectStore: store,
      now: new Date(lateFinish.getTime() + 1),
      objectGraceMs: 0,
    });
    expect(afterExpiryGrace.objectSweep).toMatchObject({ protected: 1, deletedObjectRefs: [] });
    const markedExpired = await runRuntimeRetentionMaintenance(db, {
      objectStore: store,
      now: new Date(lateFinish.getTime() + EXPIRED_SIDE_CHAT_TRANSCRIPT_RETENTION_MS + 1),
      objectGraceMs: 0,
    });
    expect(markedExpired.objectSweep).toMatchObject({ protected: 1, deletedObjectRefs: [] });
    const [markedSpan] = await db.select().from(runRuntimeSpans).where(eq(runRuntimeSpans.id, spanId));
    expect(markedSpan?.supplementalObjectRef).toBe(objectRef);
    expect(markedSpan?.supplementalRetentionExpiredAt).toBeInstanceOf(Date);

    const failedStore: TranscriptObjectStore = {
      ...store,
      sweepUnreferenced: (input) => {
        if (!input?.withRetentionGuard) throw new Error("retention guard required");
        const guard = input.withRetentionGuard;
        return store.sweepUnreferenced({
          ...input,
          withRetentionGuard: (candidate, _collect) => guard(candidate, async () => false),
        });
      },
    };
    const failedSweep = await runRuntimeRetentionMaintenance(db, {
      objectStore: failedStore,
      now: new Date(lateFinish.getTime() + EXPIRED_SIDE_CHAT_TRANSCRIPT_RETENTION_MS + 2),
      objectGraceMs: 0,
    });
    expect(failedSweep.objectSweep).toMatchObject({ skipped: 1, deletedObjectRefs: [] });
    const [span] = await db.select().from(runRuntimeSpans).where(eq(runRuntimeSpans.id, spanId));
    expect(span?.supplementalObjectRef).toBe(objectRef);
    await fs.promises.rm(path.join(root, "transcript-objects", `${objectRef}.ndjson`));
    const recoveredSweep = await runRuntimeRetentionMaintenance(db, {
      objectStore: store,
      now: new Date(lateFinish.getTime() + EXPIRED_SIDE_CHAT_TRANSCRIPT_RETENTION_MS + 3),
      objectGraceMs: 0,
    });
    expect(recoveredSweep.objectSweep.deletedObjectRefs).toContain(objectRef);
    expect(fs.existsSync(metadataPath)).toBe(false);
  });

  it("rechecks a concurrent claim acquired after maintenance discovers objects", async () => {
    const orgId = await createOrg();
    const { root, store } = createObjectStore();
    const runId = crypto.randomUUID();
    const spanId = crypto.randomUUID();
    const objectRef = await store.write({
      orgId,
      runId,
      spanId,
      ownerToken: "concurrent-owner",
      entries: [{ kind: "assistant", ts: "2026-09-23T00:00:00.000Z", text: "claimed during sweep" }],
    });
    const metadataPath = path.join(root, "transcript-objects", `${objectRef}.json`);
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
    metadata.updatedAt = new Date(Date.now() - 60_000).toISOString();
    fs.writeFileSync(metadataPath, `${JSON.stringify(metadata)}\n`, "utf8");

    let signalSweep!: () => void;
    let releaseSweep!: () => void;
    const sweepReached = new Promise<void>((resolve) => { signalSweep = resolve; });
    const sweepGate = new Promise<void>((resolve) => { releaseSweep = resolve; });
    const coordinatedStore: TranscriptObjectStore = {
      ...store,
      async sweepUnreferenced(input) {
        signalSweep();
        await sweepGate;
        return store.sweepUnreferenced(input);
      },
    };
    const maintenance = runRuntimeRetentionMaintenance(db, {
      objectStore: coordinatedStore,
      now: new Date(Date.now() + 10_000),
      objectGraceMs: 0,
    });
    await sweepReached;
    await service.ensureClaims({
      orgId,
      claims: [{
        resourceRef: objectRef,
        purpose: "transcript:concurrent-keep",
        principalScopeRef: "user:owner",
        expiresAt: null,
      }],
    });
    releaseSweep();

    const result = await maintenance;
    expect(result.objectSweep).toMatchObject({ protected: 1, deletedObjectRefs: [] });
    expect(fs.existsSync(metadataPath)).toBe(true);
    const [claim] = await db.select().from(runtimeRetentionClaims).where(and(
      eq(runtimeRetentionClaims.orgId, orgId),
      eq(runtimeRetentionClaims.resourceRef, objectRef),
    ));
    expect(claim).toMatchObject({ status: "active", expiresAt: null });
  });

  it("does not let another organization's claim protect an object", async () => {
    const objectOrgId = await createOrg();
    const claimOrgId = await createOrg();
    const { root, store } = createObjectStore();
    const runId = crypto.randomUUID();
    const spanId = crypto.randomUUID();
    const objectRef = await store.write({
      orgId: objectOrgId,
      runId,
      spanId,
      ownerToken: "organization-owner",
      entries: [{ kind: "assistant", ts: "2026-09-23T00:00:00.000Z", text: "org scoped" }],
    });
    await service.ensureClaims({
      orgId: claimOrgId,
      claims: [{
        resourceRef: objectRef,
        purpose: "transcript:foreign-claim",
        principalScopeRef: "user:other-org",
        expiresAt: null,
      }],
    });

    const result = await runRuntimeRetentionMaintenance(db, {
      objectStore: store,
      now: new Date(Date.now() + 60_000),
      objectGraceMs: 0,
    });
    expect(result.objectSweep.deletedObjectRefs).toContain(objectRef);
    expect(fs.existsSync(path.join(root, "transcript-objects", `${objectRef}.json`))).toBe(false);
    const [foreignClaim] = await db.select().from(runtimeRetentionClaims).where(and(
      eq(runtimeRetentionClaims.orgId, claimOrgId),
      eq(runtimeRetentionClaims.resourceRef, objectRef),
    ));
    expect(foreignClaim?.status).toBe("active");
  });

  it("preserves a payload-only object when its span attaches after the retention snapshot", async () => {
    const orgId = await createOrg();
    const agentId = crypto.randomUUID();
    const bindingId = crypto.randomUUID();
    const segmentId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const spanId = crypto.randomUUID();
    const ownerToken = `owner-${crypto.randomUUID()}`;
    const objectRef = `tobj_v1_${crypto.randomUUID()}`;
    const { root, store } = createObjectStore();
    const objectDir = path.join(root, "transcript-objects");
    const payloadPath = path.join(objectDir, `${objectRef}.ndjson`);
    fs.mkdirSync(objectDir, { recursive: true });
    fs.writeFileSync(payloadPath, "", "utf8");
    fs.utimesSync(payloadPath, new Date("2026-09-20T00:00:00.000Z"), new Date("2026-09-20T00:00:00.000Z"));

    await db.insert(agents).values({ id: agentId, orgId, name: "Orphan attach agent", role: "engineer" });
    await db.insert(runtimeBindings).values({
      id: bindingId, orgId, targetType: "manual", targetId: `orphan-${runId}`,
      principalScopeRef: "user:owner", agentId,
      runtimeType: "codex_local", instructionsRevision: "instructions-1",
      capabilityRevision: "capability-1", continuity: "native",
    });
    await db.insert(nativeSegments).values({
      id: segmentId, orgId, bindingId, runtimeType: "codex_local", state: "open", segmentOrdinal: 0,
    });
    await db.insert(heartbeatRuns).values({
      id: runId, orgId, agentId, status: "running", executionOwnerToken: ownerToken,
      executionLeaseExpiresAt: new Date(Date.now() + 60_000),
    });
    await db.insert(runRuntimeSpans).values({
      id: spanId, orgId, runId, bindingId, segmentId, attemptRef: "attempt-1",
      ownerToken, state: "open", supplementalObjectRef: null,
    });

    let signalSweep!: () => void;
    let releaseSweep!: () => void;
    const sweepReached = new Promise<void>((resolve) => { signalSweep = resolve; });
    const sweepGate = new Promise<void>((resolve) => { releaseSweep = resolve; });
    let retentionGuardCalls = 0;
    const coordinatedStore: TranscriptObjectStore = {
      ...store,
      async sweepUnreferenced(input) {
        signalSweep();
        await sweepGate;
        const guard = input?.withRetentionGuard;
        return store.sweepUnreferenced(input && guard ? {
          ...input,
          withRetentionGuard: (candidate, collect) => {
            retentionGuardCalls += 1;
            return guard(candidate, collect);
          },
        } : input);
      },
    };
    const maintenance = runRuntimeRetentionMaintenance(db, {
      objectStore: coordinatedStore,
      now: new Date("2026-09-24T00:00:00.000Z"),
      objectGraceMs: 0,
    });
    await sweepReached;
    const attached = await attachRuntimeSpanSupplement(db, {
      orgId, runId, spanId, ownerToken, attemptEpoch: 1, objectRef,
    });
    expect(attached?.supplementalObjectRef).toBe(objectRef);
    releaseSweep();

    const result = await maintenance;
    expect(result.objectSweep.deletedObjectRefs).toEqual([]);
    expect(retentionGuardCalls).toBe(0);
    expect(fs.existsSync(payloadPath)).toBe(true);
    const [span] = await db.select().from(runRuntimeSpans).where(eq(runRuntimeSpans.id, spanId));
    expect(span?.supplementalObjectRef).toBe(objectRef);
  });

  it("starts immediately, skips overlapping ticks, and stops the production maintenance loop", async () => {
    let callback: () => void = () => undefined;
    let clearCalls = 0;
    let calls = 0;
    let releaseFirst!: () => void;
    const firstFinished = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const scheduler = startRuntimeRetentionMaintenance(db, {
      intervalMs: 1_000,
      runMaintenance: async () => {
        calls += 1;
        if (calls === 1) await firstFinished;
      },
      setIntervalFn: (next) => {
        callback = next;
        return { unref() {} } as unknown as ReturnType<typeof setInterval>;
      },
      clearIntervalFn: () => {
        clearCalls += 1;
      },
    });
    await Promise.resolve();
    expect(calls).toBe(1);
    callback();
    expect(calls).toBe(1);
    releaseFirst();
    await new Promise<void>((resolve) => setImmediate(resolve));
    callback();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(calls).toBe(2);
    scheduler.stop();
    expect(clearCalls).toBe(1);
    callback();
    expect(calls).toBe(2);
  });
});
