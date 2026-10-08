import {
  activityLog,
  applyPendingMigrations,
  approvals,
  chatConversations,
  chatMessages,
  createDb,
  ensurePostgresDatabase,
  organizations,
} from "@rudderhq/db";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { chatService } from "./chats.js";
import { handoffOrganizationBrandingAuthority } from "./organization-branding-fence.js";
import type { RustFoundationBridge } from "./rust-foundation-bridge.js";

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
  const externalUrl = process.env.RUDDER_CHAT_BRANDING_IDEMPOTENCY_TEST_DATABASE_URL?.trim();
  if (externalUrl) {
    await applyPendingMigrations(externalUrl);
    return { connectionString: externalUrl, dataDir: "", instance: null };
  }

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-chat-branding-idempotency-"));
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

const BOARD_ACTOR = {
  type: "board",
  source: "local_implicit",
  userId: "branding-test-operator",
} as const;

type FakeBridgeOptions = {
  loseFirstResponseAfterCommit?: boolean;
  failBeforeCommit?: boolean;
};

function createFakeRustBridge(
  db: ReturnType<typeof createDb>,
  options: FakeBridgeOptions = {},
) {
  const requests: Array<{ orgId: string; body: string; idempotencyKey: string }> = [];
  const committed = new Map<string, { body: string; response: Awaited<ReturnType<typeof bridgeResponse>> }>();
  let committedWriteCount = 0;

  const organizationBrandingForActor: RustFoundationBridge["organizationBrandingForActor"] = async (
    _actor,
    orgId,
    requestBody,
    idempotencyKey,
  ) => {
    const body = requestBody.toString("utf8");
    requests.push({ orgId, body, idempotencyKey });

    if (options.failBeforeCommit) {
      throw new Error("simulated Rust bridge transport failure");
    }

    const key = `${orgId}:${idempotencyKey}`;
    const prior = committed.get(key);
    if (prior) {
      if (prior.body !== body) {
        throw new Error("Rust idempotency key was replayed with a different branding command");
      }
      return prior.response;
    }

    const patch = JSON.parse(body) as { brandColor?: string | null };
    await db.transaction(async (tx) => {
      await tx
        .update(organizations)
        .set({ brandColor: patch.brandColor ?? null, updatedAt: new Date() })
        .where(eq(organizations.id, orgId));
    });
    committedWriteCount += 1;
    const response = bridgeResponse();
    committed.set(key, { body, response });

    if (options.loseFirstResponseAfterCommit && requests.length === 1) {
      throw new Error("simulated response loss after Rust commit");
    }
    return response;
  };

  const unexpectedBridgeCall = async () => {
    throw new Error("Unexpected Rust bridge method call in Chat branding test");
  };
  const bridge = {
    mode: "shadow",
    organizationBrandingMode: "shadow",
    projectGoalSetMode: "off",
    requiresStartup: false,
    start: async () => {},
    projectRead: unexpectedBridgeCall,
    projectCreate: unexpectedBridgeCall,
    memberDirectory: unexpectedBridgeCall,
    workspaceBackupList: unexpectedBridgeCall,
    organizationBranding: unexpectedBridgeCall,
    organizationBrandingForActor,
    projectGoalSet: unexpectedBridgeCall,
    projectDelete: unexpectedBridgeCall,
    close: async () => {},
  } satisfies RustFoundationBridge;

  return {
    bridge,
    requests,
    get committedWriteCount() {
      return committedWriteCount;
    },
  };
}

function bridgeResponse() {
  return {
    status: 200,
    contentType: "application/json",
    body: Buffer.from("{}", "utf8"),
  };
}

describe("Rust-owned Chat organization branding idempotency", () => {
  let db!: ReturnType<typeof createDb>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";
  const seededOrgIds: string[] = [];

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 30_000);

  afterEach(async () => {
    for (const orgId of seededOrgIds) {
      await db.delete(activityLog).where(eq(activityLog.orgId, orgId));
      await db.delete(chatMessages).where(eq(chatMessages.orgId, orgId));
      await db.delete(approvals).where(eq(approvals.orgId, orgId));
      await db.delete(chatConversations).where(eq(chatConversations.orgId, orgId));
      await db.delete(organizations).where(eq(organizations.id, orgId));
    }
    seededOrgIds.length = 0;
  });

  afterAll(async () => {
    await instance?.stop();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function seedOrganizationConversation() {
    const orgId = randomUUID();
    const conversationId = randomUUID();
    seededOrgIds.push(orgId);
    await db.insert(organizations).values({
      id: orgId,
      name: "Branding test organization",
      description: "Keep this description unchanged",
      urlKey: `branding-${orgId}`,
      issuePrefix: `B${orgId.replaceAll("-", "").slice(0, 5).toUpperCase()}`,
      brandColor: "#112233",
      requireBoardApprovalForNewAgents: false,
    });
    await handoffOrganizationBrandingAuthority(db, orgId);
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Branding proposal test",
    });
    return { orgId, conversationId };
  }

  async function seedOperationProposal(
    scope: Awaited<ReturnType<typeof seedOrganizationConversation>>,
    patch: Record<string, unknown>,
  ) {
    const messageId = randomUUID();
    await db.insert(chatMessages).values({
      id: messageId,
      orgId: scope.orgId,
      conversationId: scope.conversationId,
      role: "assistant",
      kind: "operation_proposal",
      status: "completed",
      body: "Update organization branding",
      structuredPayload: {
        targetType: "organization",
        targetId: scope.orgId,
        summary: "Update organization branding",
        patch,
        operationProposalState: {
          status: "pending",
          decisionNote: null,
          decidedByUserId: null,
          decidedAt: null,
        },
      },
    });
    return messageId;
  }

  async function getOrganization(orgId: string) {
    const [organization] = await db
      .select({ name: organizations.name, description: organizations.description, brandColor: organizations.brandColor })
      .from(organizations)
      .where(eq(organizations.id, orgId));
    if (!organization) throw new Error("Seeded organization disappeared");
    return organization;
  }

  it("retries a proposal after Rust committed but its first response was lost", async () => {
    const scope = await seedOrganizationConversation();
    const messageId = await seedOperationProposal(scope, { brandColor: "#445566" });
    const fake = createFakeRustBridge(db, { loseFirstResponseAfterCommit: true });
    const chats = chatService(db, undefined, fake.bridge);
    const input = {
      action: "approve" as const,
      actorUserId: BOARD_ACTOR.userId,
      actor: BOARD_ACTOR,
    };

    await expect(chats.resolveOperationProposal(scope.conversationId, messageId, input))
      .rejects.toThrow("simulated response loss after Rust commit");
    expect(await getOrganization(scope.orgId)).toMatchObject({ brandColor: "#445566" });
    expect(fake.committedWriteCount).toBe(1);
    expect(await db.select().from(activityLog).where(eq(activityLog.orgId, scope.orgId))).toHaveLength(0);
    expect((await db.select().from(chatMessages).where(eq(chatMessages.orgId, scope.orgId)))
      .filter((message) => message.structuredPayload?.eventType === "operation_applied"))
      .toHaveLength(0);

    await chats.resolveOperationProposal(scope.conversationId, messageId, input);
    await chats.resolveOperationProposal(scope.conversationId, messageId, input);

    const proposalRequests = fake.requests.filter((request) => request.orgId === scope.orgId);
    expect(proposalRequests).toHaveLength(3);
    expect(proposalRequests[0]?.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
    expect(proposalRequests.map((request) => request.idempotencyKey)).toEqual([
      proposalRequests[0]?.idempotencyKey,
      proposalRequests[0]?.idempotencyKey,
      proposalRequests[0]?.idempotencyKey,
    ]);
    expect(fake.committedWriteCount).toBe(1);

    const messages = await db.select().from(chatMessages).where(eq(chatMessages.orgId, scope.orgId));
    const appliedMessages = messages.filter((message) =>
      message.role === "system"
      && message.kind === "system_event"
      && message.structuredPayload?.eventType === "operation_applied"
      && message.structuredPayload.sourceMessageId === messageId,
    );
    expect(appliedMessages).toHaveLength(1);
    expect(appliedMessages[0]?.clientMutationId)
      .toBe(`chat-proposal:${messageId}:organization-applied`);

    const activities = await db.select().from(activityLog).where(and(
      eq(activityLog.orgId, scope.orgId),
      eq(activityLog.action, "organization.updated"),
    ));
    expect(activities).toHaveLength(1);
    expect(activities[0]?.details).toMatchObject({
      source: "chat_lightweight_change",
      sourceMessageId: messageId,
      brandColor: "#445566",
    });
    expect(activities[0]?.idempotencyKey)
      .toBe(`chat-proposal:${messageId}:organization-activity`);
  });

  it("rejects mixed organization fields before either writer runs", async () => {
    const scope = await seedOrganizationConversation();
    const messageId = await seedOperationProposal(scope, {
      brandColor: "#445566",
      name: "Must not be written",
    });
    const fake = createFakeRustBridge(db);
    const chats = chatService(db, undefined, fake.bridge);

    await expect(chats.resolveOperationProposal(scope.conversationId, messageId, {
      action: "approve",
      actorUserId: BOARD_ACTOR.userId,
      actor: BOARD_ACTOR,
    })).rejects.toMatchObject({ status: 422 });

    expect(fake.requests).toHaveLength(0);
    expect(fake.committedWriteCount).toBe(0);
    expect(await getOrganization(scope.orgId)).toEqual({
      name: "Branding test organization",
      description: "Keep this description unchanged",
      brandColor: "#112233",
    });
    expect(await db.select().from(activityLog).where(eq(activityLog.orgId, scope.orgId)))
      .toHaveLength(0);
    expect((await db.select().from(chatMessages).where(eq(chatMessages.orgId, scope.orgId)))
      .filter((message) => message.structuredPayload?.eventType === "operation_applied"))
      .toHaveLength(0);
  });

  it("does not fall back to the Node writer when the Rust bridge errors", async () => {
    const scope = await seedOrganizationConversation();
    const messageId = await seedOperationProposal(scope, { brandColor: "#445566" });
    const fake = createFakeRustBridge(db, { failBeforeCommit: true });
    const chats = chatService(db, undefined, fake.bridge);

    await expect(chats.resolveOperationProposal(scope.conversationId, messageId, {
      action: "approve",
      actorUserId: BOARD_ACTOR.userId,
      actor: BOARD_ACTOR,
    })).rejects.toThrow("simulated Rust bridge transport failure");

    expect(fake.requests).toHaveLength(1);
    expect(fake.committedWriteCount).toBe(0);
    expect(await getOrganization(scope.orgId)).toMatchObject({
      name: "Branding test organization",
      brandColor: "#112233",
    });
    expect(await db.select().from(activityLog).where(eq(activityLog.orgId, scope.orgId)))
      .toHaveLength(0);
    expect((await db.select().from(chatMessages).where(eq(chatMessages.orgId, scope.orgId)))
      .filter((message) => message.structuredPayload?.eventType === "operation_applied"))
      .toHaveLength(0);
  });

  it("keeps approval recovery idempotent across a lost response and repeated recovery", async () => {
    const scope = await seedOrganizationConversation();
    const messageId = randomUUID();
    const [approval] = await db.insert(approvals).values({
      orgId: scope.orgId,
      type: "chat_operation",
      requestedByAgentId: null,
      requestedByUserId: BOARD_ACTOR.userId,
      status: "approved",
      payload: {
        chatConversationId: scope.conversationId,
        chatMessageId: messageId,
        operationProposal: {
          targetType: "organization",
          targetId: scope.orgId,
          summary: "Update organization branding",
          patch: { brandColor: "#778899" },
        },
      },
      decisionNote: null,
      decidedByUserId: BOARD_ACTOR.userId,
      decidedAt: new Date(),
    }).returning();
    if (!approval) throw new Error("Failed to seed approved Chat operation");
    await db.insert(chatMessages).values({
      id: messageId,
      orgId: scope.orgId,
      conversationId: scope.conversationId,
      role: "assistant",
      kind: "operation_proposal",
      status: "completed",
      body: "Update organization branding",
      approvalId: approval.id,
      structuredPayload: {
        targetType: "organization",
        targetId: scope.orgId,
        summary: "Update organization branding",
        patch: { brandColor: "#778899" },
      },
    });

    const fake = createFakeRustBridge(db, { loseFirstResponseAfterCommit: true });
    const chats = chatService(db, undefined, fake.bridge);
    const recover = () => chats.applyApprovedApproval(
      approval,
      BOARD_ACTOR.userId,
      BOARD_ACTOR,
      { recoveryOnly: true },
    );

    await expect(recover()).rejects.toThrow("simulated response loss after Rust commit");
    await recover();
    await recover();

    expect(fake.requests).toHaveLength(3);
    expect(new Set(fake.requests.map((request) => request.idempotencyKey)).size).toBe(1);
    expect(fake.committedWriteCount).toBe(1);
    expect(await getOrganization(scope.orgId)).toMatchObject({ brandColor: "#778899" });

    const messages = await db.select().from(chatMessages).where(eq(chatMessages.orgId, scope.orgId));
    const appliedMessages = messages.filter((message) =>
      message.role === "system"
      && message.kind === "system_event"
      && message.structuredPayload?.eventType === "operation_applied"
      && message.structuredPayload.approvalId === approval.id,
    );
    expect(appliedMessages).toHaveLength(1);
    expect(appliedMessages[0]?.clientMutationId)
      .toBe(`chat-approval:${approval.id}:organization-applied`);

    const activities = await db.select().from(activityLog).where(and(
      eq(activityLog.orgId, scope.orgId),
      eq(activityLog.action, "organization.updated"),
    ));
    expect(activities).toHaveLength(1);
    expect(activities[0]?.idempotencyKey)
      .toBe(`chat-approval:${approval.id}:organization-activity`);
  });
});
