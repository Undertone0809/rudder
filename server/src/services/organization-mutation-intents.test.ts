import {
  applyPendingMigrations,
  activityLog,
  approvals,
  chatConversations,
  chatMessages,
  createDb,
  ensurePostgresDatabase,
  organizationMutationIntents,
  organizations,
} from "@rudderhq/db";
import { deriveOrganizationUrlKey } from "@rudderhq/shared";
import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  organizationMutationIntentCoordinator,
  organizationSettingsIntentFingerprint,
  organizationSettingsPatchFingerprint,
  type OrganizationMutationIntentCallbacks,
  type OrganizationMutationIntentStep,
  type OrganizationSettingsIntentInput,
} from "./organization-mutation-intents.js";
import { approvalService } from "./approvals.js";
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

async function availablePort() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not allocate a test port")));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function startDatabase() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-rudder-name-intents-"));
  const port = await availablePort();
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
  await instance.initialise();
  await instance.start();
  const adminUrl = `postgres://rudder:rudder@127.0.0.1:${port}/postgres`;
  await ensurePostgresDatabase(adminUrl, "rudder");
  const connectionString = `postgres://rudder:rudder@127.0.0.1:${port}/rudder`;
  await applyPendingMigrations(connectionString);
  return { dataDir, instance, connectionString };
}

describe("organization mutation intent coordinator", () => {
  let db!: ReturnType<typeof createDb>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";
  const organizationIds: string[] = [];

  beforeAll(async () => {
    const started = await startDatabase();
    db = createDb(started.connectionString);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 60_000);

  afterEach(async () => {
    for (const orgId of organizationIds.splice(0)) {
      await db.delete(approvals).where(eq(approvals.orgId, orgId));
      await db.delete(activityLog).where(eq(activityLog.orgId, orgId));
      await db.delete(organizations).where(eq(organizations.id, orgId));
    }
  });

  afterAll(async () => {
    await instance?.stop();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function fixture() {
    const orgId = randomUUID();
    const conversationId = randomUUID();
    const messageId = randomUUID();
    organizationIds.push(orgId);
    await db.insert(organizations).values({
      id: orgId,
      name: "Intent test organization",
      urlKey: deriveOrganizationUrlKey(`Intent test ${orgId}`),
      issuePrefix: `T${orgId.replaceAll("-", "").slice(0, 7).toUpperCase()}`,
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Intent test chat",
      issueCreationMode: "manual_approval",
      planMode: false,
    });
    await db.insert(chatMessages).values({
      id: messageId,
      orgId,
      conversationId,
      role: "assistant",
      kind: "operation_proposal",
      status: "completed",
      body: "Rename organization",
      structuredPayload: {
        operationProposal: {
          targetType: "organization",
          targetId: orgId,
          summary: "Rename organization",
          patch: { name: "Renamed organization" },
        },
      },
    });
    const patch = { name: "Renamed organization" } as const;
    const patchFingerprint = organizationSettingsPatchFingerprint(patch);
    const input: OrganizationSettingsIntentInput = {
      orgId,
      source: {
        kind: "chat_lightweight",
        sourceId: messageId,
        approvalId: null,
        conversationId,
        proposalMessageId: messageId,
      },
      actorUserId: "user-1",
      actorPrincipal: "board",
      decidedByUserId: "user-1",
      decisionNote: "approved",
      generation: 1n,
      patch,
      rustIdempotencyKey: `test-organization-settings:${messageId}`,
    };
    input.patchFingerprint = patchFingerprint;
    input.intentFingerprint = organizationSettingsIntentFingerprint({
      orgId,
      source: input.source,
      actorUserId: input.actorUserId,
      actorPrincipal: input.actorPrincipal,
      decidedByUserId: input.decidedByUserId,
      decisionNote: input.decisionNote,
      generation: input.generation,
      patchFingerprint,
      rustIdempotencyKey: input.rustIdempotencyKey!,
    });
    return { input, messageId, orgId };
  }

  function callbacks(onEffect?: OrganizationMutationIntentStep): OrganizationMutationIntentCallbacks {
    return {
      applyEffects: async ({ runStep }) => {
        await runStep("message", "proposal", onEffect ?? (async () => {}));
      },
    };
  }

  it("keeps Rust intent identity stable across decision display metadata", async () => {
    const { input } = await fixture();
    const first = organizationSettingsIntentFingerprint({
      orgId: input.orgId,
      source: input.source,
      actorUserId: input.actorUserId,
      actorPrincipal: input.actorPrincipal,
      decidedByUserId: "user-1",
      decisionNote: "first note",
      generation: input.generation,
      patchFingerprint: input.patchFingerprint!,
      rustIdempotencyKey: input.rustIdempotencyKey!,
    });
    const second = organizationSettingsIntentFingerprint({
      orgId: input.orgId,
      source: input.source,
      actorUserId: input.actorUserId,
      actorPrincipal: input.actorPrincipal,
      decidedByUserId: "user-2",
      decisionNote: "replayed display note",
      generation: input.generation,
      patchFingerprint: input.patchFingerprint!,
      rustIdempotencyKey: input.rustIdempotencyKey!,
    });
    expect(second).toBe(first);
  });

  it("persists the claim before source cleanup and completes from the durable receipt", async () => {
    const { input, messageId } = await fixture();
    let executions = 0;
    const coordinator = organizationMutationIntentCoordinator(db, {
      workerId: "test-worker-claim",
      executor: async (context) => {
        executions += 1;
        await db.delete(chatMessages).where(eq(chatMessages.id, messageId));
        const receipt = { organization_id: input.orgId, version: "1", fence_epoch: "0" };
        await db
          .update(organizationMutationIntents)
          .set({
            phase: "rust_committed",
            rustReceipt: receipt,
            rustCommittedAt: new Date(),
            claimToken: null,
            claimOwner: null,
            leaseExpiresAt: null,
          })
          .where(and(
            eq(organizationMutationIntents.id, context.intentId),
            eq(organizationMutationIntents.claimToken, context.claimToken),
          ));
        return receipt;
      },
    });

    const result = await coordinator.run(input, callbacks());
    const [row] = await db
      .select({ phase: organizationMutationIntents.phase, rustReceipt: organizationMutationIntents.rustReceipt })
      .from(organizationMutationIntents)
      .where(eq(organizationMutationIntents.rustIdempotencyKey, input.rustIdempotencyKey!));
    expect(result.status).toBe("completed");
    expect(executions).toBe(1);
    expect(row?.phase).toBe("completed");
    expect(row?.rustReceipt).toMatchObject({ organization_id: input.orgId });
  });

  it("reclaims an approved Chat intent after approval cleanup without losing its source snapshot", async () => {
    const { input, orgId, messageId } = await fixture();
    const approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId,
      orgId,
      type: "chat_operation",
      status: "pending",
      payload: {
        chatConversationId: input.source.conversationId,
        chatMessageId: messageId,
        operationProposal: {
          targetType: "organization",
          targetId: orgId,
          summary: "Rename organization",
          patch: input.patch,
        },
      },
      requestedByAgentId: null,
      requestedByUserId: "requester",
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
    });
    await db
      .update(chatMessages)
      .set({ approvalId })
      .where(eq(chatMessages.id, messageId));

    const approvalInput: OrganizationSettingsIntentInput = {
      ...input,
      source: {
        kind: "chat_approval",
        sourceId: approvalId,
        approvalId,
        conversationId: input.source.conversationId,
        proposalMessageId: messageId,
      },
      rustIdempotencyKey: `test-organization-settings:approval-cleanup:${approvalId}`,
      intentFingerprint: undefined,
    };
    approvalInput.intentFingerprint = organizationSettingsIntentFingerprint({
      orgId,
      source: approvalInput.source,
      actorUserId: approvalInput.actorUserId,
      actorPrincipal: approvalInput.actorPrincipal,
      decidedByUserId: approvalInput.decidedByUserId,
      decisionNote: approvalInput.decisionNote,
      generation: approvalInput.generation,
      patchFingerprint: approvalInput.patchFingerprint!,
      rustIdempotencyKey: approvalInput.rustIdempotencyKey!,
    });

    let executions = 0;
    const coordinator = organizationMutationIntentCoordinator(db, {
      workerId: "test-worker-approval-cleanup",
      executor: async () => {
        executions += 1;
        return { organization_id: orgId, version: "1", fence_epoch: "0" };
      },
    });
    const claimed = await coordinator.enqueueAndClaim(approvalInput);
    expect(claimed.kind).toBe("claimed");

    await db.delete(approvals).where(eq(approvals.id, approvalId));
    const [survivingMessage] = await db
      .select({ approvalId: chatMessages.approvalId })
      .from(chatMessages)
      .where(eq(chatMessages.id, messageId));
    expect(survivingMessage?.approvalId).toBeNull();
    await db
      .update(organizationMutationIntents)
      .set({ leaseExpiresAt: new Date(0) })
      .where(eq(organizationMutationIntents.rustIdempotencyKey, approvalInput.rustIdempotencyKey!));

    const result = await coordinator.run(approvalInput, callbacks());
    expect(result.status).toBe("completed");
    expect(executions).toBe(1);
  });

  it("passes the downstream claim to lightweight proposal message effects", async () => {
    const { input, messageId } = await fixture();
    const coordinator = organizationMutationIntentCoordinator(db, {
      workerId: "test-worker-lightweight-effects",
      executor: async () => ({ organization_id: input.orgId, version: "1", fence_epoch: "0" }),
    });
    const service = chatService(db, undefined, {
      organizationMutationCoordinator: coordinator,
    });

    await service.resolveOperationProposal(input.source.conversationId, messageId, {
      action: "approve",
      actorUserId: "user-1",
      decisionNote: "Apply the approved name",
    });

    const [message] = await db
      .select({ structuredPayload: chatMessages.structuredPayload })
      .from(chatMessages)
      .where(eq(chatMessages.id, messageId));
    const [intent] = await db
      .select({ phase: organizationMutationIntents.phase })
      .from(organizationMutationIntents)
      .where(eq(organizationMutationIntents.sourceId, messageId));
    expect((message?.structuredPayload as Record<string, any>)?.operationProposalState?.status).toBe("approved");
    expect(intent?.phase).toBe("completed");
  });

  it("recovers a Rust-committed intent after source cleanup without replaying Rust", async () => {
    const { input, orgId } = await fixture();
    const receipt = { organization_id: orgId, version: "1", fence_epoch: "0" };
    await db.execute(sql`
      INSERT INTO organization_mutation_intents (
        org_id, command_kind, source_kind, source_id, approval_id,
        conversation_id, proposal_message_id, actor_user_id, actor_principal,
        decided_by_user_id, decision_note, generation, patch,
        patch_fingerprint, intent_fingerprint, rust_idempotency_key,
        phase, rust_receipt, rust_committed_at
      ) VALUES (
        ${input.orgId}::uuid, 'organization_settings', ${input.source.kind},
        ${input.source.sourceId}::uuid, NULL, ${input.source.conversationId}::uuid,
        ${input.source.proposalMessageId}::uuid, ${input.actorUserId},
        ${input.actorPrincipal}, ${input.decidedByUserId}, ${input.decisionNote},
        ${input.generation}, ${JSON.stringify(input.patch)}::jsonb,
        ${input.patchFingerprint!}, ${input.intentFingerprint!}, ${input.rustIdempotencyKey!},
        'rust_committed', ${JSON.stringify(receipt)}::jsonb, now()
      )
    `);
    await db.delete(chatConversations).where(eq(chatConversations.id, input.source.conversationId));
    let executions = 0;
    const coordinator = organizationMutationIntentCoordinator(db, {
      executor: async () => {
        executions += 1;
        throw new Error("Rust must not be replayed after its receipt committed");
      },
    });

    const result = await coordinator.run(input, callbacks());
    const [row] = await db
      .select({ phase: organizationMutationIntents.phase, rustReceipt: organizationMutationIntents.rustReceipt })
      .from(organizationMutationIntents)
      .where(eq(organizationMutationIntents.rustIdempotencyKey, input.rustIdempotencyKey!));
    expect(result.status).toBe("completed");
    expect(executions).toBe(0);
    expect(row?.phase).toBe("completed");
    expect(row?.rustReceipt).toEqual(receipt);
  });

  it("rejects a durable receipt that disagrees with the Rust response", async () => {
    const { input } = await fixture();
    let executions = 0;
    const durableReceipt = { organization_id: input.orgId, version: "1", fence_epoch: "0" };
    const coordinator = organizationMutationIntentCoordinator(db, {
      executor: async (context) => {
        executions += 1;
        await db
          .update(organizationMutationIntents)
          .set({
            phase: "downstream_pending",
            rustReceipt: durableReceipt,
            rustCommittedAt: new Date(),
            claimToken: null,
            claimOwner: null,
            leaseExpiresAt: null,
          })
          .where(and(
            eq(organizationMutationIntents.id, context.intentId),
            eq(organizationMutationIntents.claimToken, context.claimToken),
          ));
        return { organization_id: input.orgId, version: "2", fence_epoch: "0" };
      },
    });

    await expect(coordinator.run(input, callbacks())).rejects.toMatchObject({
      details: { code: "InvalidReceipt" },
    });
    expect(executions).toBe(1);
    const [row] = await db
      .select({ phase: organizationMutationIntents.phase, rustReceipt: organizationMutationIntents.rustReceipt })
      .from(organizationMutationIntents)
      .where(eq(organizationMutationIntents.rustIdempotencyKey, input.rustIdempotencyKey!));
    expect(row).toEqual({ phase: "downstream_pending", rustReceipt: durableReceipt });
  });

  it("retries a failed claim with a new lease and the same command key", async () => {
    const { input } = await fixture();
    let executions = 0;
    const coordinator = organizationMutationIntentCoordinator(db, {
      workerId: "test-worker-retry",
      executor: async () => {
        executions += 1;
        if (executions === 1) throw new Error("native process exited");
        return { organization_id: input.orgId, version: "1", fence_epoch: "0" };
      },
    });

    await expect(coordinator.run(input, callbacks())).rejects.toThrow("native process exited");
    await db
      .update(organizationMutationIntents)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(organizationMutationIntents.rustIdempotencyKey, input.rustIdempotencyKey!));
    const result = await coordinator.run(input, callbacks());
    expect(result.status).toBe("completed");
    expect(executions).toBe(2);
    const [row] = await db
      .select({ attempts: organizationMutationIntents.attempts, phase: organizationMutationIntents.phase })
      .from(organizationMutationIntents)
      .where(eq(organizationMutationIntents.rustIdempotencyKey, input.rustIdempotencyKey!));
    expect(row).toEqual({ attempts: 2, phase: "completed" });
  });

  it("does not let a second publisher execute an active claim or replay Rust", async () => {
    const { input } = await fixture();
    let executions = 0;
    let releaseRust!: () => void;
    let markRustStarted!: () => void;
    const rustStarted = new Promise<void>((resolve) => {
      markRustStarted = resolve;
    });
    const releaseRustPromise = new Promise<void>((resolve) => {
      releaseRust = resolve;
    });
    const first = organizationMutationIntentCoordinator(db, {
      workerId: "test-worker-first",
      executor: async () => {
        executions += 1;
        markRustStarted();
        await releaseRustPromise;
        return { organization_id: input.orgId, version: "1", fence_epoch: "0" };
      },
    });
    const second = organizationMutationIntentCoordinator(db, {
      workerId: "test-worker-second",
      executor: async () => {
        executions += 1;
        return { organization_id: input.orgId, version: "1", fence_epoch: "0" };
      },
    });

    const firstRun = first.run(input, callbacks());
    await rustStarted;
    const busy = await second.run(input, callbacks());
    expect(busy.status).toBe("in_progress");
    const sameWorkerBusy = await first.run(input, callbacks());
    expect(sameWorkerBusy.status).toBe("in_progress");
    expect(executions).toBe(1);

    releaseRust();
    const completed = await firstRun;
    expect(completed.status).toBe("completed");
    const replay = await first.run(input, callbacks());
    expect(replay.status).toBe("replayed");
    expect(executions).toBe(1);
  });

  it("fails closed when a pending intent loses its source before claim", async () => {
    const { input, messageId } = await fixture();
    await db.execute(sql`
      INSERT INTO organization_mutation_intents (
        org_id, command_kind, source_kind, source_id, approval_id,
        conversation_id, proposal_message_id, actor_user_id, actor_principal,
        decided_by_user_id, decision_note, generation, patch,
        patch_fingerprint, intent_fingerprint, rust_idempotency_key
      ) VALUES (
        ${input.orgId}::uuid, 'organization_settings', ${input.source.kind},
        ${input.source.sourceId}::uuid, NULL, ${input.source.conversationId}::uuid,
        ${input.source.proposalMessageId}::uuid, ${input.actorUserId},
        ${input.actorPrincipal}, ${input.decidedByUserId}, ${input.decisionNote},
        ${input.generation}, ${JSON.stringify(input.patch)}::jsonb,
        ${input.patchFingerprint ?? "a".repeat(64)},
        ${input.intentFingerprint ?? "b".repeat(64)}, ${input.rustIdempotencyKey!}
      )
    `);
    await db.delete(chatMessages).where(eq(chatMessages.id, messageId));
    const coordinator = organizationMutationIntentCoordinator(db, {
      executor: async () => ({ organization_id: input.orgId, version: "1", fence_epoch: "0" }),
    });

    await expect(coordinator.run(input, callbacks())).rejects.toMatchObject({
      details: { code: "InvalidIntent" },
    });
  });

  it("does not claim a lightweight proposal after its decision is rejected", async () => {
    const { input, messageId } = await fixture();
    await db
      .update(chatMessages)
      .set({
        structuredPayload: {
          operationProposal: {
            targetType: "organization",
            targetId: input.orgId,
            summary: "Rename organization",
            patch: input.patch,
          },
          operationProposalState: {
            status: "rejected",
            decisionNote: "Keep the current name",
            decidedByUserId: "user-1",
            decidedAt: new Date().toISOString(),
          },
        },
      })
      .where(eq(chatMessages.id, messageId));
    const coordinator = organizationMutationIntentCoordinator(db, {
      executor: async () => ({ organization_id: input.orgId, version: "1", fence_epoch: "0" }),
    });

    await expect(coordinator.run(input, callbacks())).rejects.toMatchObject({
      details: { code: "InvalidIntent" },
    });
  });

  it("blocks lightweight rejection while its intent claim is active", async () => {
    const { input, messageId } = await fixture();
    const coordinator = organizationMutationIntentCoordinator(db, {
      workerId: "test-worker-lightweight-rejection",
      executor: async () => ({ organization_id: input.orgId, version: "1", fence_epoch: "0" }),
    });
    const claimed = await coordinator.enqueueAndClaim(input);
    expect(claimed.kind).toBe("claimed");

    await expect(chatService(db).resolveOperationProposal(input.source.conversationId, messageId, {
      action: "reject",
      actorUserId: "user-1",
      decisionNote: "Reject while native work is in flight",
    })).rejects.toMatchObject({ status: 409 });
    const [message] = await db
      .select({ structuredPayload: chatMessages.structuredPayload })
      .from(chatMessages)
      .where(eq(chatMessages.id, messageId));
    expect((message?.structuredPayload as Record<string, any>)?.operationProposalState?.status).toBeUndefined();
  });

  it("serializes approval rejection behind a claimed organization intent", async () => {
    const { input, orgId, messageId } = await fixture();
    const approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId,
      orgId,
      type: "chat_operation",
      status: "pending",
      payload: {
        chatConversationId: input.source.conversationId,
        chatMessageId: messageId,
        operationProposal: {
          targetType: "organization",
          targetId: orgId,
          summary: "Rename organization",
          patch: input.patch,
        },
      },
      requestedByAgentId: null,
      requestedByUserId: "requester",
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
    });
    await db
      .update(chatMessages)
      .set({ approvalId })
      .where(eq(chatMessages.id, messageId));
    const approvalInput: OrganizationSettingsIntentInput = {
      ...input,
      source: {
        kind: "chat_approval",
        sourceId: approvalId,
        approvalId,
        conversationId: input.source.conversationId,
        proposalMessageId: messageId,
      },
      rustIdempotencyKey: `test-organization-settings:approval:${approvalId}`,
      intentFingerprint: undefined,
    };
    approvalInput.intentFingerprint = organizationSettingsIntentFingerprint({
      orgId,
      source: approvalInput.source,
      actorUserId: approvalInput.actorUserId,
      actorPrincipal: approvalInput.actorPrincipal,
      decidedByUserId: approvalInput.decidedByUserId,
      decisionNote: approvalInput.decisionNote,
      generation: approvalInput.generation,
      patchFingerprint: approvalInput.patchFingerprint!,
      rustIdempotencyKey: approvalInput.rustIdempotencyKey!,
    });
    const coordinator = organizationMutationIntentCoordinator(db, {
      workerId: "test-worker-approval-claim",
      executor: async () => ({ organization_id: orgId, version: "1", fence_epoch: "0" }),
    });
    const claimed = await coordinator.enqueueAndClaim(approvalInput);
    expect(claimed.kind).toBe("claimed");

    await expect(approvalService(db).reject(approvalId, "board", "stale proposal"))
      .rejects.toMatchObject({ status: 409 });
    const [approval] = await db
      .select({ status: approvals.status })
      .from(approvals)
      .where(eq(approvals.id, approvalId));
    expect(approval?.status).toBe("pending");
  });
});
