import type { TranscriptEntry } from "@rudderhq/agent-runtime-utils";
import {
  agents,
  applyPendingMigrations,
  chatConversations,
  createDb,
  ensurePostgresDatabase,
  heartbeatRuns,
  organizations,
  runRuntimeSpans,
} from "@rudderhq/db";
import { deriveOrganizationUrlKey } from "@rudderhq/shared";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { chatAgentRunService } from "../chat-agent-runs.js";
import type { HeartbeatTranscriptRetentionInput } from "./heartbeat-transcript-retention.js";
import { currentNativeSession, ensureRuntimeBinding } from "./native-session.js";
import { createTranscriptObjectStore } from "./transcript-object-store.js";
import { createHeartbeatUnifiedAgentRunAdapter } from "./unified-agent-run.integration.js";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (options: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags: string[];
  onLog: (message: unknown) => void;
  onError: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

type ChatRuns = ReturnType<typeof chatAgentRunService>;
type ChatRun = Awaited<ReturnType<ChatRuns["createRun"]>>;
type Fixture = {
  orgId: string;
  binding: Awaited<ReturnType<typeof ensureRuntimeBinding>>;
  run: ChatRun;
  runs: ChatRuns;
  objectRoot: string;
  store: ReturnType<typeof createTranscriptObjectStore>;
};

const ownedRuns: Array<{ runs: ChatRuns; run: ChatRun }> = [];
const objectRoots: string[] = [];

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate isolated PostgreSQL port")));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function startIsolatedPostgres() {
  // This test intentionally never reads an external DATABASE_URL override.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-native-execution-handoff-pg-"));
  const port = await getAvailablePort();
  const module = await import("embedded-postgres");
  const EmbeddedPostgres = module.default as EmbeddedPostgresCtor;
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
  try {
    await instance.initialise();
    await instance.start();
    const adminUrl = `postgres://rudder:rudder@127.0.0.1:${port}/postgres`;
    await ensurePostgresDatabase(adminUrl, "rudder");
    const connectionString = `postgres://rudder:rudder@127.0.0.1:${port}/rudder`;
    await applyPendingMigrations(connectionString);
    return { dataDir, instance, connectionString };
  } catch (error) {
    await instance.stop().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
    throw error;
  }
}

function nativeProfile(binding: Awaited<ReturnType<typeof ensureRuntimeBinding>>) {
  const providerBinding = {
    id: binding.id,
    orgId: binding.orgId,
    hostId: binding.hostId,
    profileId: binding.profileId,
    workspaceBindingId: binding.workspaceBindingId,
    capabilityRevision: binding.capabilityRevision,
  };
  return {
    runtimeType: "codex_local",
    binding: providerBinding,
    driverStatus: "supported",
    resolution: {
      runtimeType: "codex_local",
      binding: providerBinding,
      profileResolved: true,
      adapter: {
        runtimeType: "codex_local",
        transcript: {
          evidence: { status: "supported", profileBound: true, reason: "isolated native handoff fixture" },
          readRange: async () => { throw new Error("handoff identity test must not invoke a provider reader"); },
        },
      },
    },
  } as NonNullable<HeartbeatTranscriptRetentionInput["profileCapability"]>;
}

describe("native execution compact handoff owner recovery with PostgreSQL", () => {
  let db!: ReturnType<typeof createDb>;
  let instance: EmbeddedPostgresInstance | null = null;
  let databaseDir = "";

  beforeAll(async () => {
    const started = await startIsolatedPostgres();
    db = createDb(started.connectionString);
    instance = started.instance;
    databaseDir = started.dataDir;
  }, 60_000);

  afterEach(async () => {
    for (const owned of ownedRuns.splice(0)) {
      owned.runs.releaseOwnedRun(owned.run.id, owned.run.runtimeSpanOwnerToken);
    }
    await Promise.all(objectRoots.splice(0).map((root) => fs.promises.rm(root, { recursive: true, force: true })));
  });

  afterAll(async () => {
    await instance?.stop();
    if (databaseDir) fs.rmSync(databaseDir, { recursive: true, force: true });
  }, 30_000);

  async function createFixture(label: string): Promise<Fixture> {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const conversationId = randomUUID();
    const name = `${label} ${orgId}`;
    await db.insert(organizations).values({
      id: orgId,
      name,
      urlKey: deriveOrganizationUrlKey(name),
      issuePrefix: `N${orgId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: `${label} agent`,
      role: "engineer",
      status: "active",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: `${label} conversation`,
      issueCreationMode: "manual_approval",
      planMode: false,
    });
    const binding = await ensureRuntimeBinding(db, {
      orgId,
      conversationId,
      principalScopeRef: `user:${orgId}`,
      agentId,
      runtimeType: "codex_local",
      hostId: "local",
      profileId: "default",
      continuity: "native",
      capabilityRevision: "isolated-handoff-test",
    });
    const session = await currentNativeSession(db, binding);
    const objectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-native-execution-handoff-objects-"));
    objectRoots.push(objectRoot);
    const store = createTranscriptObjectStore(objectRoot);
    const runs = chatAgentRunService(db, { transcriptObjectStore: store, leaseRenewIntervalMs: 60_000 });
    const run = await runs.createRun({
      conversation: { id: conversationId, orgId, primaryIssueId: null, planMode: false },
      agentId,
      triggerDetail: "chat_assistant_reply",
      linkedIssueIds: [],
      linkedProjectId: null,
      runtimeBinding: binding,
      runtimeSegment: session.segment,
      nativeSessionId: session.sessionId,
      nativeSessionParams: session.sessionParams,
      inputCorrelationRef: randomUUID(),
      runtimeModel: "synthetic-no-provider",
    });
    ownedRuns.push({ runs, run });
    return { orgId, binding, run, runs, objectRoot, store };
  }

  async function readSpan(fixture: Fixture) {
    const span = await db.select().from(runRuntimeSpans).where(and(
      eq(runRuntimeSpans.orgId, fixture.orgId),
      eq(runRuntimeSpans.runId, fixture.run.id),
      eq(runRuntimeSpans.id, fixture.run.runtimeSpanId!),
    )).limit(1).then((rows) => rows[0] ?? null);
    if (!span) throw new Error("Expected the persisted native Run span");
    return span;
  }

  it("persists exact selector, reuses one child under a new SQL owner, and fences stale writes", async () => {
    const fixture = await createFixture("native execution handoff");
    const profile = nativeProfile(fixture.binding);
    const selector = { kind: "codex_turn" as const, threadId: "thread-native-1", turnId: "turn-native-1" };
    const prefix: TranscriptEntry = {
      kind: "assistant", ts: "2026-10-04T00:00:00.000Z", sourceEntryId: "early-entry-1", text: "durable native prefix",
    };
    await fixture.runs.appendTranscriptEntry(fixture.run, prefix, {
      spanId: fixture.run.runtimeSpanId,
      persistRaw: false,
      persistSupplement: true,
      nativeProfileCapability: profile,
    });

    const beforeIdentity = await readSpan(fixture);
    const rootRef = beforeIdentity.supplementalObjectRef;
    expect(rootRef).toBeTruthy();
    const objectDir = path.join(fixture.objectRoot, "transcript-objects");
    const rootPayloadPath = path.join(objectDir, `${rootRef}.ndjson`);
    const rootPayloadBefore = await fs.promises.readFile(rootPayloadPath);
    const firstOwnerRootMetadataBefore = JSON.parse(
      await fs.promises.readFile(path.join(objectDir, `${rootRef}.json`), "utf8"),
    );
    expect(firstOwnerRootMetadataBefore).toMatchObject({ earlyHandoffEligible: true, entryCount: 1 });
    expect(firstOwnerRootMetadataBefore.encoding).toBeUndefined();

    await fixture.runs.bindNativeExecutionIdentity(fixture.run, selector, profile);
    const boundSpan = await readSpan(fixture);
    expect(boundSpan).toMatchObject({
      ownerToken: fixture.run.runtimeSpanOwnerToken,
      attemptEpoch: fixture.run.runtimeSpanAttemptEpoch,
      nativeExecutionRef: selector.turnId,
      supplementalObjectRef: rootRef,
      selectorJson: { ...selector, runId: fixture.run.id },
    });
    const firstOwnerRootMetadata = JSON.parse(
      await fs.promises.readFile(path.join(objectDir, `${rootRef}.json`), "utf8"),
    );
    expect(firstOwnerRootMetadata.compactHandoff).toMatchObject({
      prefixEntryCount: 1,
      compactHandoffSelectorSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    const childRef = firstOwnerRootMetadata.compactHandoff.objectRef as string;
    const childMetadata = JSON.parse(await fs.promises.readFile(path.join(objectDir, `${childRef}.json`), "utf8"));
    expect(childMetadata).toMatchObject({
      encoding: "codex-gap-dictionary-v1",
      compactHandoffParentRef: rootRef,
      compactHandoffSelectorSha256: firstOwnerRootMetadata.compactHandoff.compactHandoffSelectorSha256,
      entryCount: 1,
    });
    expect(await fs.promises.readFile(rootPayloadPath)).toEqual(rootPayloadBefore);

    fixture.runs.releaseOwnedRun(fixture.run.id, fixture.run.runtimeSpanOwnerToken);
    await db.update(heartbeatRuns).set({ executionLeaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(heartbeatRuns.id, fixture.run.id));
    const nextOwnerToken = `native-handoff-recovery-${randomUUID()}`;
    const claim = await createHeartbeatUnifiedAgentRunAdapter(db).claimOwner(fixture.run.id, {
      ownerToken: nextOwnerToken,
    });
    if (!claim.ok) throw new Error(`Expected isolated owner takeover, got ${claim.reason}`);
    expect(claim.value).toMatchObject({ ownerToken: nextOwnerToken, attemptEpoch: 2 });

    const recoveredRuns = chatAgentRunService(db, {
      transcriptObjectStore: createTranscriptObjectStore(fixture.objectRoot),
      leaseRenewIntervalMs: 60_000,
    });
    const recoveredRun = await recoveredRuns.adoptRecoveredRun(fixture.run.id, nextOwnerToken);
    if (!recoveredRun) throw new Error("Expected the recovered native Run to be adopted");
    ownedRuns.push({ runs: recoveredRuns, run: recoveredRun });
    expect(recoveredRun).toMatchObject({
      runtimeSpanId: fixture.run.runtimeSpanId,
      runtimeSpanOwnerToken: nextOwnerToken,
      runtimeSpanAttemptEpoch: 2,
      runtimeAttemptRef: { id: fixture.run.runtimeAttemptRef?.id },
    });

    // The persisted selector is stable, while owner/epoch are correctly new.
    // This call must validate the already-published child, not allocate or
    // rewrite a different child under the recovery owner.
    await recoveredRuns.bindNativeExecutionIdentity(recoveredRun, selector, profile);
    const recoveredSpan = await readSpan({ ...fixture, run: recoveredRun });
    expect(recoveredSpan).toMatchObject({
      ownerToken: nextOwnerToken,
      attemptEpoch: 2,
      nativeExecutionRef: selector.turnId,
      supplementalObjectRef: rootRef,
      selectorJson: { ...selector, runId: fixture.run.id },
    });
    const recoveredRootMetadataBytes = await fs.promises.readFile(path.join(objectDir, `${rootRef}.json`));
    const recoveredChildPayloadBytes = await fs.promises.readFile(path.join(objectDir, `${childRef}.ndjson`));
    expect(JSON.parse(recoveredRootMetadataBytes.toString("utf8")).compactHandoff.objectRef).toBe(childRef);

    const staleEntry: TranscriptEntry = {
      kind: "assistant", ts: "2026-10-04T00:00:01.000Z", sourceEntryId: "stale-entry", text: "must remain unwritten",
    };
    await expect(fixture.runs.bindNativeExecutionIdentity(
      fixture.run, selector, profile,
    )).rejects.toThrow();
    await expect(fixture.runs.appendTranscriptEntry(fixture.run, staleEntry, {
      spanId: fixture.run.runtimeSpanId,
      persistRaw: false,
      persistSupplement: true,
      nativeProfileCapability: profile,
    })).rejects.toThrow();
    await expect(recoveredRuns.bindNativeExecutionIdentity({
      ...recoveredRun,
      runtimeSpanOwnerToken: `forged-${randomUUID()}`,
    }, selector, profile)).rejects.toThrow();
    await expect(recoveredRuns.bindNativeExecutionIdentity({
      ...recoveredRun,
      runtimeSpanAttemptEpoch: 3,
    }, selector, profile)).rejects.toThrow();

    const afterRejectedWrites = await readSpan({ ...fixture, run: recoveredRun });
    expect(afterRejectedWrites).toMatchObject({
      ownerToken: nextOwnerToken,
      attemptEpoch: 2,
      nativeExecutionRef: selector.turnId,
      supplementalObjectRef: rootRef,
    });
    expect(await fs.promises.readFile(path.join(objectDir, `${rootRef}.json`))).toEqual(recoveredRootMetadataBytes);
    expect(await fs.promises.readFile(path.join(objectDir, `${childRef}.ndjson`))).toEqual(recoveredChildPayloadBytes);
    expect((await fs.promises.readdir(objectDir)).filter((name) => name.endsWith(".json"))).toHaveLength(2);

    const suffix: TranscriptEntry = {
      kind: "assistant", ts: "2026-10-04T00:00:02.000Z", sourceEntryId: "recovered-entry", text: "current owner append",
    };
    await recoveredRuns.appendTranscriptEntry(recoveredRun, suffix, {
      spanId: recoveredRun.runtimeSpanId,
      persistRaw: false,
      persistSupplement: true,
      nativeProfileCapability: profile,
    });
    const recoveredStore = createTranscriptObjectStore(fixture.objectRoot);
    await expect(recoveredStore.readRange({
      orgId: fixture.orgId,
      runId: recoveredRun.id,
      spanId: recoveredRun.runtimeSpanId!,
      ownerToken: nextOwnerToken,
      objectRef: rootRef!,
      limit: 20,
      allowOwnerRecovery: true,
    })).resolves.toMatchObject({ entries: [prefix, suffix] });
    expect(await fs.promises.readFile(rootPayloadPath)).toEqual(rootPayloadBefore);
    expect(JSON.parse(await fs.promises.readFile(path.join(objectDir, `${rootRef}.json`), "utf8"))
      .compactHandoff.objectRef).toBe(childRef);
  });

  it("does not upgrade an already-attached native v1 supplement after identity arrives", async () => {
    const fixture = await createFixture("legacy native supplement");
    const profile = nativeProfile(fixture.binding);
    const selector = { kind: "codex_turn" as const, threadId: "thread-native-legacy", turnId: "turn-native-legacy" };
    const existingEntry: TranscriptEntry = {
      kind: "assistant", ts: "2026-10-04T00:10:00.000Z", sourceEntryId: "legacy-entry-1", text: "existing native evidence",
    };
    await fixture.runs.appendTranscriptEntry(fixture.run, existingEntry, {
      spanId: fixture.run.runtimeSpanId,
      persistRaw: false,
      persistSupplement: true,
    });

    const beforeBind = await readSpan(fixture);
    const objectRef = beforeBind.supplementalObjectRef;
    expect(objectRef).toBeTruthy();
    const objectDir = path.join(fixture.objectRoot, "transcript-objects");
    const metadataPath = path.join(objectDir, `${objectRef}.json`);
    const payloadPath = path.join(objectDir, `${objectRef}.ndjson`);
    const metadataBytes = await fs.promises.readFile(metadataPath);
    const payloadBytes = await fs.promises.readFile(payloadPath);
    const originalMetadata = JSON.parse(metadataBytes.toString("utf8"));
    expect(originalMetadata.earlyHandoffEligible).toBeUndefined();
    expect(originalMetadata.encoding).toBeUndefined();

    await fixture.runs.bindNativeExecutionIdentity(fixture.run, selector, profile);
    const afterBind = await readSpan(fixture);
    expect(afterBind).toMatchObject({
      supplementalObjectRef: objectRef,
      nativeExecutionRef: selector.turnId,
      selectorJson: { ...selector, runId: fixture.run.id },
    });
    expect(await fs.promises.readFile(metadataPath)).toEqual(metadataBytes);
    expect(await fs.promises.readFile(payloadPath)).toEqual(payloadBytes);
    expect(JSON.parse((await fs.promises.readFile(metadataPath)).toString("utf8")).compactHandoff).toBeUndefined();
  });
});
