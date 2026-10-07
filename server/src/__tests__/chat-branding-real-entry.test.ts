import {
  activityLog,
  agentApiKeys,
  agents,
  applyPendingMigrations,
  approvals,
  authUsers,
  boardApiKeys,
  chatConversations,
  chatMessages,
  createDb,
  ensurePostgresDatabase,
  organizationBrandingMutationReceipts,
  organizationBrandingMutationState,
  organizationMemberships,
  organizationMutationOutbox,
  organizations,
} from "@rudderhq/db";
import { deriveOrganizationUrlKey } from "@rudderhq/shared";
import { and, asc, eq, inArray } from "drizzle-orm";
import express from "express";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import type { Server } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { approvalRoutes } from "../routes/approvals.js";
import { createChatBackgroundRuntime } from "../routes/chat-background-runtime.js";
import { chatRoutes } from "../routes/chats.js";
import { handoffOrganizationBrandingAuthority } from "../services/organization-branding-fence.js";
import { createRustFoundationBridge, type RustFoundationBridge } from "../services/rust-foundation-bridge.js";
import type { StorageService } from "../storage/types.js";

// This suite crosses the authenticated public Node API, the signed private
// Actix/SQLx bridge, and disposable PostgreSQL. It intentionally fails closed
// when the candidate's native foundation binary is missing.
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
  onLog: () => void;
  onError: () => void;
}) => EmbeddedPostgresInstance;

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
      const { port } = address;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function closeServer(server: Server | undefined) {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

function idempotencyKey(source: "chat-proposal" | "chat-approval", sourceId: string) {
  return createHash("sha256")
    .update(`rudder.${source}.organization-branding.v1\0${sourceId}`)
    .digest("hex");
}

function normalizeEvidence(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeEvidence);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, normalizeEvidence(entry)]),
    );
  }
  return value;
}

function emitRealEntryEvidence(scenario: string, evidence: Record<string, unknown>) {
  console.info(`[chat-branding-real-entry] ${JSON.stringify(normalizeEvidence({ scenario, ...evidence }))}`);
}

describe("Chat organization branding through authenticated Node API and Rust", () => {
  let db: ReturnType<typeof createDb> | undefined;
  let database: EmbeddedPostgresInstance | undefined;
  let dataDir = "";
  let home = "";
  let connectionString = "";
  let bridge: RustFoundationBridge | undefined;
  let server: Server | undefined;
  let chatBackground: ReturnType<typeof createChatBackgroundRuntime> | undefined;
  const orgId = randomUUID();
  const boardUserId = `chat-branding-${randomUUID()}`;
  const boardToken = `pcp_board_${randomUUID()}${randomUUID()}`;
  const createdAt = new Date();
  const originalEnv = {
    RUDDER_HOME: process.env.RUDDER_HOME,
    RUDDER_INSTANCE_ID: process.env.RUDDER_INSTANCE_ID,
    RUDDER_ORGANIZATION_WORKSPACE_HOME: process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME,
  };

  async function seedConversation(patch: Record<string, unknown>, summary: string) {
    const conversationId = randomUUID();
    const messageId = randomUUID();
    await db!.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: summary,
      createdByUserId: boardUserId,
    });
    await db!.insert(chatMessages).values({
      id: messageId,
      orgId,
      conversationId,
      role: "assistant",
      kind: "operation_proposal",
      body: summary,
      structuredPayload: {
        operationProposal: {
          targetType: "organization",
          targetId: orgId,
          summary,
          patch,
        },
        operationProposalState: {
          status: "pending",
          decisionNote: null,
          decidedByUserId: null,
          decidedAt: null,
        },
      },
    });
    return { conversationId, messageId };
  }

  async function seedOrganization(namePrefix: string) {
    const id = randomUUID();
    const name = `${namePrefix} ${id}`;
    await db!.insert(organizations).values({
      id,
      name,
      urlKey: deriveOrganizationUrlKey(name),
      issuePrefix: `CB${id.replaceAll("-", "").slice(0, 8).toUpperCase()}`,
    });
    return id;
  }

  async function seedConversationForOrganization(
    targetOrgId: string,
    patch: Record<string, unknown>,
    summary: string,
  ) {
    const conversationId = randomUUID();
    const messageId = randomUUID();
    await db!.insert(chatConversations).values({
      id: conversationId,
      orgId: targetOrgId,
      title: summary,
      createdByUserId: boardUserId,
    });
    await db!.insert(chatMessages).values({
      id: messageId,
      orgId: targetOrgId,
      conversationId,
      role: "assistant",
      kind: "operation_proposal",
      body: summary,
      structuredPayload: {
        operationProposal: {
          targetType: "organization",
          targetId: targetOrgId,
          summary,
          patch,
        },
        operationProposalState: {
          status: "pending",
          decisionNote: null,
          decidedByUserId: null,
          decidedAt: null,
        },
      },
    });
    return { conversationId, messageId };
  }

  async function seedAgent(orgId: string, role: string, token: string) {
    const agentId = randomUUID();
    await db!.insert(agents).values({
      id: agentId,
      orgId,
      name: `${role} Chat branding test agent`,
      role,
      status: "idle",
    });
    await db!.insert(agentApiKeys).values({
      orgId,
      agentId,
      name: "Chat branding authorization test",
      keyHash: createHash("sha256").update(token).digest("hex"),
    });
    return agentId;
  }

  async function readBrandColor() {
    const row = await db!.select({ brandColor: organizations.brandColor })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .then((rows) => rows[0]);
    return row?.brandColor ?? null;
  }

  beforeAll(async () => {
    const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const binaryName = process.platform === "win32" ? "rudder-server-foundation.exe" : "rudder-server-foundation";
    const targetRoot = path.resolve(repoRoot, process.env.CARGO_TARGET_DIR ?? "native/target");
    const explicitBinary = process.env.RUDDER_SERVER_FOUNDATION_PATH?.trim();
    const candidates = explicitBinary
      ? [explicitBinary]
      : [path.join(targetRoot, "debug", binaryName), path.join(targetRoot, "release", binaryName)];
    const nativeBinary = candidates.find((candidate) => {
      try {
        fs.accessSync(candidate, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
        return fs.statSync(candidate).isFile();
      } catch {
        return false;
      }
    }) ?? candidates[0]!;
    try {
      fs.accessSync(nativeBinary, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
    } catch {
      throw new Error(`Real Chat branding integration requires a built foundation binary at ${nativeBinary}. Run cargo build --locked --manifest-path native/Cargo.toml -p rudder-server-foundation --bin rudder-server-foundation, or set RUDDER_SERVER_FOUNDATION_PATH.`);
    }

    home = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-chat-branding-home-"));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-chat-branding-postgres-"));
    process.env.RUDDER_HOME = home;
    process.env.RUDDER_INSTANCE_ID = `chat-branding-${randomUUID()}`;
    delete process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME;

    const port = await getAvailablePort();
    const EmbeddedPostgres = (await import("embedded-postgres")).default as EmbeddedPostgresCtor;
    database = new EmbeddedPostgres({
      databaseDir: dataDir,
      user: "rudder",
      password: "rudder",
      port,
      persistent: true,
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
      onLog: () => {},
      onError: () => {},
    });
    await database.initialise();
    await database.start();
    await ensurePostgresDatabase(`postgres://rudder:rudder@127.0.0.1:${port}/postgres`, "rudder");
    connectionString = `postgres://rudder:rudder@127.0.0.1:${port}/rudder`;
    await applyPendingMigrations(connectionString);
    db = createDb(connectionString);

    await db.insert(organizations).values({
      id: orgId,
      name: "Chat branding integration",
      urlKey: deriveOrganizationUrlKey(`Chat branding ${orgId}`),
      issuePrefix: `CB${orgId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
    });
    await handoffOrganizationBrandingAuthority(db, orgId);
    const ownership = await db.select({ owner: organizationBrandingMutationState.owner })
      .from(organizationBrandingMutationState)
      .where(eq(organizationBrandingMutationState.orgId, orgId))
      .then((rows) => rows[0]);
    expect(ownership?.owner).toBe("rust");

    await db.insert(authUsers).values({
      id: boardUserId,
      name: "Chat branding operator",
      email: `${boardUserId}@example.test`,
      createdAt,
      updatedAt: createdAt,
    });
    await db.insert(organizationMemberships).values({
      orgId,
      principalType: "user",
      principalId: boardUserId,
      status: "active",
      membershipRole: "admin",
    });
    await db.insert(boardApiKeys).values({
      userId: boardUserId,
      name: "Chat branding real-entry test",
      keyHash: createHash("sha256").update(boardToken).digest("hex"),
    });

    bridge = createRustFoundationBridge({
      databaseUrl: connectionString,
      binaryPath: nativeBinary,
      mode: "off",
      organizationBrandingMode: "required",
      requestTimeoutMs: 10_000,
    });
    await bridge.start();

    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "authenticated", authRequirement: "required" }));
    chatBackground = createChatBackgroundRuntime();
    app.use("/api", chatRoutes(
      db,
      {} as StorageService,
      chatBackground,
      undefined,
      bridge,
    ));
    app.use("/api", approvalRoutes(db, bridge));
    app.use(errorHandler);
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
  }, 60_000);

  afterAll(async () => {
    await closeServer(server);
    await chatBackground?.close();
    await bridge?.close();
    await db?.$client.end({ timeout: 5 });
    await database?.stop();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
    if (home) fs.rmSync(home, { recursive: true, force: true });
    if (originalEnv.RUDDER_HOME === undefined) delete process.env.RUDDER_HOME;
    else process.env.RUDDER_HOME = originalEnv.RUDDER_HOME;
    if (originalEnv.RUDDER_INSTANCE_ID === undefined) delete process.env.RUDDER_INSTANCE_ID;
    else process.env.RUDDER_INSTANCE_ID = originalEnv.RUDDER_INSTANCE_ID;
    if (originalEnv.RUDDER_ORGANIZATION_WORKSPACE_HOME === undefined) delete process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME;
    else process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME = originalEnv.RUDDER_ORGANIZATION_WORKSPACE_HOME;
  });

  it("replays Chat proposal and approval writes after response loss without duplicate side effects", async () => {
    const direct = await seedConversation({ brandColor: "#123456" }, "Apply a Chat branding proposal");
    const directKey = idempotencyKey("chat-proposal", direct.messageId);
    const directNodeAuditKey = `chat-proposal:${direct.messageId}:organization-activity`;
    const directBridge = bridge!.organizationBrandingForActor.bind(bridge);
    let loseDirectResponse = true;
    bridge!.organizationBrandingForActor = async (...args) => {
      const response = await directBridge(...args);
      if (loseDirectResponse) {
        loseDirectResponse = false;
        throw new Error("simulated response loss after Rust commit");
      }
      return response;
    };

    const directPath = `/api/chats/${direct.conversationId}/messages/${direct.messageId}/operation-proposal/resolve`;
    const directFirst = await request(server!)
      .post(directPath)
      .set("authorization", `Bearer ${boardToken}`)
      .send({ action: "approve", decisionNote: "Looks good" });
    expect(directFirst.status).toBe(500);
    expect(await readBrandColor()).toBe("#123456");
    expect(await db!.select().from(organizationBrandingMutationReceipts)
      .where(and(
        eq(organizationBrandingMutationReceipts.orgId, orgId),
        eq(organizationBrandingMutationReceipts.idempotencyKey, directKey),
      ))).toHaveLength(1);
    expect(await db!.select().from(chatMessages).where(and(
      eq(chatMessages.conversationId, direct.conversationId),
      eq(chatMessages.kind, "system_event"),
    ))).toHaveLength(0);
    expect(await db!.select().from(activityLog).where(eq(activityLog.idempotencyKey, directNodeAuditKey))).toHaveLength(0);

    const directRetry = await request(server!)
      .post(directPath)
      .set("authorization", `Bearer ${boardToken}`)
      .send({ action: "approve", decisionNote: "Looks good" });
    expect(directRetry.status, JSON.stringify(directRetry.body)).toBe(201);
    expect(await db!.select().from(organizationBrandingMutationReceipts)
      .where(and(
        eq(organizationBrandingMutationReceipts.orgId, orgId),
        eq(organizationBrandingMutationReceipts.idempotencyKey, directKey),
      ))).toHaveLength(1);
    expect(await db!.select().from(chatMessages).where(and(
      eq(chatMessages.conversationId, direct.conversationId),
      eq(chatMessages.kind, "system_event"),
    ))).toHaveLength(1);
    expect(await db!.select().from(activityLog).where(eq(activityLog.idempotencyKey, directNodeAuditKey))).toHaveLength(1);
    expect(await db!.select().from(activityLog).where(and(
      eq(activityLog.orgId, orgId),
      eq(activityLog.action, "organization.branding_updated"),
    ))).toHaveLength(1);

    bridge!.organizationBrandingForActor = directBridge;

    const mixed = await seedConversation({ brandColor: "#654321", name: "must-not-be-written" }, "Reject mixed Chat patch");
    const mixedResponse = await request(server!)
      .post(`/api/chats/${mixed.conversationId}/messages/${mixed.messageId}/operation-proposal/resolve`)
      .set("authorization", `Bearer ${boardToken}`)
      .send({ action: "approve" });
    expect(mixedResponse.status).toBe(422);
    expect(await readBrandColor()).toBe("#123456");
    expect(await db!.select().from(organizationBrandingMutationReceipts)
      .where(eq(organizationBrandingMutationReceipts.orgId, orgId))).toHaveLength(1);

    const unavailable = await seedConversation({ brandColor: "#abcdef" }, "Fail closed when Rust is unavailable");
    bridge!.organizationBrandingForActor = async () => {
      throw new Error("simulated Rust bridge outage");
    };
    const unavailableResponse = await request(server!)
      .post(`/api/chats/${unavailable.conversationId}/messages/${unavailable.messageId}/operation-proposal/resolve`)
      .set("authorization", `Bearer ${boardToken}`)
      .send({ action: "approve" });
    expect(unavailableResponse.status).toBe(500);
    expect(await readBrandColor()).toBe("#123456");
    expect(await db!.select().from(organizationBrandingMutationReceipts)
      .where(eq(organizationBrandingMutationReceipts.orgId, orgId))).toHaveLength(1);
    bridge!.organizationBrandingForActor = directBridge;

    const mixedApprovalConversationId = randomUUID();
    const mixedApprovalId = randomUUID();
    await db!.insert(chatConversations).values({
      id: mixedApprovalConversationId,
      orgId,
      title: "Reject mixed Rust-owned Chat approval",
      createdByUserId: boardUserId,
    });
    await db!.insert(approvals).values({
      id: mixedApprovalId,
      orgId,
      type: "chat_operation",
      status: "pending",
      payload: {
        chatConversationId: mixedApprovalConversationId,
        operationProposal: {
          targetType: "organization",
          targetId: orgId,
          summary: "Reject a mixed organization patch",
          patch: { brandColor: "#fedcba", name: "must-not-be-written" },
        },
      },
    });
    const beforeMixedApproval = await db!.select({ name: organizations.name, brandColor: organizations.brandColor })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .then((rows) => rows[0]);
    const mixedApprovalMutationKey = idempotencyKey("chat-approval", mixedApprovalId);
    const mixedApprovalAuditKey = `approval-approved:${mixedApprovalId}`;
    const mixedApprovalOrganizationAuditKey = `chat-approval:${mixedApprovalId}:organization-activity`;
    let mixedApprovalBridgeCalls = 0;
    bridge!.organizationBrandingForActor = async (...args) => {
      mixedApprovalBridgeCalls += 1;
      return directBridge(...args);
    };
    const mixedApprovalResponse = await request(server!)
      .post(`/api/approvals/${mixedApprovalId}/approve`)
      .set("authorization", `Bearer ${boardToken}`)
      .send({ decisionNote: "This mixed patch must remain pending" });
    expect(mixedApprovalResponse.status).toBe(422);
    expect(mixedApprovalBridgeCalls).toBe(0);
    expect(await db!.select().from(approvals)
      .where(eq(approvals.id, mixedApprovalId))
      .then((rows) => rows[0])).toMatchObject({
      status: "pending",
      decidedByUserId: null,
      decidedAt: null,
      decisionNote: null,
    });
    expect(await db!.select({ name: organizations.name, brandColor: organizations.brandColor })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .then((rows) => rows[0])).toEqual(beforeMixedApproval);
    expect(await db!.select().from(organizationBrandingMutationReceipts)
      .where(and(
        eq(organizationBrandingMutationReceipts.orgId, orgId),
        eq(organizationBrandingMutationReceipts.idempotencyKey, mixedApprovalMutationKey),
      ))).toHaveLength(0);
    expect(await db!.select().from(chatMessages).where(and(
      eq(chatMessages.conversationId, mixedApprovalConversationId),
      eq(chatMessages.kind, "system_event"),
    ))).toHaveLength(0);
    expect(await db!.select().from(activityLog).where(and(
      eq(activityLog.orgId, orgId),
      eq(activityLog.entityId, mixedApprovalId),
      eq(activityLog.action, "approval.approved"),
    ))).toHaveLength(0);
    expect(await db!.select().from(activityLog).where(eq(activityLog.idempotencyKey, mixedApprovalOrganizationAuditKey)))
      .toHaveLength(0);
    expect(await db!.select().from(activityLog).where(eq(activityLog.idempotencyKey, mixedApprovalAuditKey)))
      .toHaveLength(0);

    const mixedApprovalReject = await request(server!)
      .post(`/api/approvals/${mixedApprovalId}/reject`)
      .set("authorization", `Bearer ${boardToken}`)
      .send({ decidedByUserId: boardUserId, decisionNote: "Reject the invalid mixed patch" });
    expect(mixedApprovalReject.status).toBe(200);
    expect(await db!.select().from(approvals)
      .where(eq(approvals.id, mixedApprovalId))
      .then((rows) => rows[0])).toMatchObject({ status: "rejected" });
    bridge!.organizationBrandingForActor = directBridge;

    const approvalConversationId = randomUUID();
    const approvalId = randomUUID();
    await db!.insert(chatConversations).values({
      id: approvalConversationId,
      orgId,
      title: "Approved branding recovery",
      createdByUserId: boardUserId,
    });
    await db!.insert(approvals).values({
      id: approvalId,
      orgId,
      type: "chat_operation",
      status: "pending",
      payload: {
        chatConversationId: approvalConversationId,
        operationProposal: {
          targetType: "organization",
          targetId: orgId,
          summary: "Change organization brand color",
          patch: { brandColor: "#aabbcc" },
        },
      },
    });
    const approvalKey = idempotencyKey("chat-approval", approvalId);
    const approvalNodeAuditKey = `chat-approval:${approvalId}:organization-activity`;
    const approvalAuditKey = `approval-approved:${approvalId}`;
    let loseApprovalResponse = true;
    bridge!.organizationBrandingForActor = async (...args) => {
      const response = await directBridge(...args);
      if (loseApprovalResponse) {
        loseApprovalResponse = false;
        throw new Error("simulated approval response loss after Rust commit");
      }
      return response;
    };

    const approvalPath = `/api/approvals/${approvalId}/approve`;
    const approvalFirst = await request(server!)
      .post(approvalPath)
      .set("authorization", `Bearer ${boardToken}`)
      .send({ decidedByUserId: "spoofed-user", decisionNote: "Approved" });
    expect(approvalFirst.status).toBe(500);
    const persistedApproval = await db!.select().from(approvals)
      .where(eq(approvals.id, approvalId)).then((rows) => rows[0]);
    expect(persistedApproval).toMatchObject({ status: "approved", decidedByUserId: boardUserId });
    expect(await readBrandColor()).toBe("#aabbcc");
    expect(await db!.select().from(organizationBrandingMutationReceipts)
      .where(and(
        eq(organizationBrandingMutationReceipts.orgId, orgId),
        eq(organizationBrandingMutationReceipts.idempotencyKey, approvalKey),
      ))).toHaveLength(1);
    expect(await db!.select().from(chatMessages).where(and(
      eq(chatMessages.conversationId, approvalConversationId),
      eq(chatMessages.kind, "system_event"),
    ))).toHaveLength(0);
    expect(await db!.select().from(activityLog).where(eq(activityLog.idempotencyKey, approvalNodeAuditKey))).toHaveLength(0);
    expect(await db!.select().from(activityLog).where(eq(activityLog.idempotencyKey, approvalAuditKey))).toHaveLength(0);

    const approvalRetry = await request(server!)
      .post(approvalPath)
      .set("authorization", `Bearer ${boardToken}`)
      .send({ decidedByUserId: "spoofed-user", decisionNote: "Approved" });
    expect(approvalRetry.status, JSON.stringify(approvalRetry.body)).toBe(200);
    expect(await readBrandColor()).toBe("#aabbcc");
    expect(await db!.select().from(organizationBrandingMutationReceipts)
      .where(and(
        eq(organizationBrandingMutationReceipts.orgId, orgId),
        eq(organizationBrandingMutationReceipts.idempotencyKey, approvalKey),
      ))).toHaveLength(1);
    expect(await db!.select().from(chatMessages).where(and(
      eq(chatMessages.conversationId, approvalConversationId),
      eq(chatMessages.kind, "system_event"),
    ))).toHaveLength(1);
    expect(await db!.select().from(activityLog).where(eq(activityLog.idempotencyKey, approvalNodeAuditKey))).toHaveLength(1);
    const recoveredApprovalAudit = await db!.select().from(activityLog)
      .where(eq(activityLog.idempotencyKey, approvalAuditKey));
    expect(recoveredApprovalAudit).toHaveLength(1);
    expect(recoveredApprovalAudit[0]).toMatchObject({
      action: "approval.approved",
      actorType: "user",
      actorId: boardUserId,
      entityType: "approval",
      entityId: approvalId,
    });
    expect(await db!.select().from(activityLog).where(and(
      eq(activityLog.orgId, orgId),
      eq(activityLog.action, "organization.branding_updated"),
    ))).toHaveLength(2);

    const approvalRepeatedRetry = await request(server!)
      .post(approvalPath)
      .set("authorization", `Bearer ${boardToken}`)
      .send({ decidedByUserId: "spoofed-user", decisionNote: "Approved" });
    expect(approvalRepeatedRetry.status).toBe(200);
    expect(await db!.select().from(activityLog).where(eq(activityLog.idempotencyKey, approvalAuditKey)))
      .toHaveLength(1);
    expect(await db!.select().from(chatMessages).where(and(
      eq(chatMessages.conversationId, approvalConversationId),
      eq(chatMessages.kind, "system_event"),
    ))).toHaveLength(1);

    bridge!.organizationBrandingForActor = directBridge;
    const successfulApprovalConversationId = randomUUID();
    const successfulApprovalId = randomUUID();
    await db!.insert(chatConversations).values({
      id: successfulApprovalConversationId,
      orgId,
      title: "Approve branding through the real bridge",
      createdByUserId: boardUserId,
    });
    await db!.insert(approvals).values({
      id: successfulApprovalId,
      orgId,
      type: "chat_operation",
      status: "pending",
      payload: {
        chatConversationId: successfulApprovalConversationId,
        operationProposal: {
          targetType: "organization",
          targetId: orgId,
          summary: "Apply a real-bridge branding approval",
          patch: { brandColor: "#778899" },
        },
      },
    });
    const successfulApprovalKey = idempotencyKey("chat-approval", successfulApprovalId);
    const successfulApprovalNodeAuditKey = `chat-approval:${successfulApprovalId}:organization-activity`;
    const successfulApprovalAuditKey = `approval-approved:${successfulApprovalId}`;
    const successfulApprovalPath = `/api/approvals/${successfulApprovalId}/approve`;
    const successfulApprovalFirst = await request(server!)
      .post(successfulApprovalPath)
      .set("authorization", `Bearer ${boardToken}`)
      .send({ decidedByUserId: "spoofed-user", decisionNote: "Approved through the real bridge" });
    expect(successfulApprovalFirst.status, JSON.stringify(successfulApprovalFirst.body)).toBe(200);

    const successfulApproval = await db!.select().from(approvals)
      .where(eq(approvals.id, successfulApprovalId)).then((rows) => rows[0]);
    expect(successfulApproval).toMatchObject({
      status: "approved",
      decidedByUserId: boardUserId,
      decisionNote: "Approved through the real bridge",
    });
    expect(await readBrandColor()).toBe("#778899");
    const successfulApprovalReceipts = await db!.select().from(organizationBrandingMutationReceipts)
      .where(and(
        eq(organizationBrandingMutationReceipts.orgId, orgId),
        eq(organizationBrandingMutationReceipts.idempotencyKey, successfulApprovalKey),
      ));
    expect(successfulApprovalReceipts).toHaveLength(1);
    expect(successfulApprovalReceipts[0]).toMatchObject({
      orgId,
      idempotencyKey: successfulApprovalKey,
      outcome: "applied",
    });
    const successfulRustActivity = await db!.select().from(activityLog)
      .where(eq(activityLog.id, successfulApprovalReceipts[0]!.activityId));
    expect(successfulRustActivity).toHaveLength(1);
    expect(successfulRustActivity[0]).toMatchObject({
      orgId,
      actorType: "user",
      actorId: boardUserId,
      action: "organization.branding_updated",
      entityType: "organization",
      entityId: orgId,
    });
    const successfulApprovalAudit = await db!.select().from(activityLog)
      .where(eq(activityLog.idempotencyKey, successfulApprovalAuditKey));
    expect(successfulApprovalAudit).toHaveLength(1);
    expect(successfulApprovalAudit[0]).toMatchObject({
      orgId,
      actorType: "user",
      actorId: boardUserId,
      action: "approval.approved",
      entityType: "approval",
      entityId: successfulApprovalId,
    });
    expect(await db!.select().from(activityLog)
      .where(eq(activityLog.idempotencyKey, successfulApprovalNodeAuditKey))).toHaveLength(1);
    const successfulApprovalMessages = await db!.select().from(chatMessages).where(and(
      eq(chatMessages.conversationId, successfulApprovalConversationId),
      eq(chatMessages.kind, "system_event"),
    ));
    expect(successfulApprovalMessages).toHaveLength(1);
    expect(successfulApprovalMessages[0]).toMatchObject({
      role: "system",
      body: "Applied approved organization change: Apply a real-bridge branding approval.",
      structuredPayload: expect.objectContaining({
        eventType: "operation_applied",
        approvalId: successfulApprovalId,
        targetType: "organization",
        targetId: orgId,
      }),
    });

    const successfulApprovalRetry = await request(server!)
      .post(successfulApprovalPath)
      .set("authorization", `Bearer ${boardToken}`)
      .send({ decidedByUserId: "spoofed-user", decisionNote: "Approved through the real bridge" });
    expect(successfulApprovalRetry.status, JSON.stringify(successfulApprovalRetry.body)).toBe(200);
    expect(await db!.select().from(approvals)
      .where(eq(approvals.id, successfulApprovalId)).then((rows) => rows[0])).toMatchObject({
      status: "approved",
      decidedByUserId: boardUserId,
      decisionNote: "Approved through the real bridge",
    });
    expect(await readBrandColor()).toBe("#778899");
    expect(await db!.select().from(organizationBrandingMutationReceipts)
      .where(and(
        eq(organizationBrandingMutationReceipts.orgId, orgId),
        eq(organizationBrandingMutationReceipts.idempotencyKey, successfulApprovalKey),
      ))).toHaveLength(1);
    expect(await db!.select().from(activityLog)
      .where(eq(activityLog.id, successfulApprovalReceipts[0]!.activityId))).toMatchObject([
      expect.objectContaining({
        actorType: "user",
        actorId: boardUserId,
        action: "organization.branding_updated",
        entityId: orgId,
      }),
    ]);
    expect(await db!.select().from(activityLog)
      .where(eq(activityLog.idempotencyKey, successfulApprovalAuditKey))).toMatchObject([
      expect.objectContaining({
        actorType: "user",
        actorId: boardUserId,
        action: "approval.approved",
        entityId: successfulApprovalId,
      }),
    ]);
    expect(await db!.select().from(activityLog)
      .where(eq(activityLog.idempotencyKey, successfulApprovalNodeAuditKey))).toHaveLength(1);
    expect(await db!.select().from(chatMessages).where(and(
      eq(chatMessages.conversationId, successfulApprovalConversationId),
      eq(chatMessages.kind, "system_event"),
    ))).toHaveLength(1);
    expect(await db!.select().from(activityLog).where(and(
      eq(activityLog.orgId, orgId),
      eq(activityLog.action, "organization.branding_updated"),
    ))).toHaveLength(3);
  }, 60_000);

  it("keeps a Node-owned non-branding organization proposal on Node", async () => {
    const nodeOrgId = await seedOrganization("Node-owned Chat proposal");
    await db!.insert(organizationMemberships).values({
      orgId: nodeOrgId,
      principalType: "user",
      principalId: boardUserId,
      status: "active",
      membershipRole: "admin",
    });
    const proposal = await seedConversationForOrganization(
      nodeOrgId,
      { name: "Updated through the Node-owned Chat path" },
      "Update the organization name",
    );
    const [initialAuthority] = await db!.select().from(organizationBrandingMutationState)
      .where(eq(organizationBrandingMutationState.orgId, nodeOrgId));
    expect(initialAuthority).toMatchObject({ owner: "node", fenceEpoch: 0n });

    const directBridge = bridge!.organizationBrandingForActor.bind(bridge);
    let brandingBridgeCalls = 0;
    bridge!.organizationBrandingForActor = async (...args) => {
      brandingBridgeCalls += 1;
      return directBridge(...args);
    };
    let responseStatus: number | undefined;
    let responseBody: unknown;
    try {
      const response = await request(server!)
        .post(`/api/chats/${proposal.conversationId}/messages/${proposal.messageId}/operation-proposal/resolve`)
        .set("authorization", `Bearer ${boardToken}`)
        .send({ action: "approve", decisionNote: "Keep this on Node" });
      responseStatus = response.status;
      responseBody = response.body;
    } finally {
      bridge!.organizationBrandingForActor = directBridge;
    }

    expect(responseStatus, JSON.stringify(responseBody)).toBe(201);
    expect(brandingBridgeCalls).toBe(0);
    const [updatedOrganization] = await db!.select({
      name: organizations.name,
    }).from(organizations).where(eq(organizations.id, nodeOrgId));
    expect(updatedOrganization?.name).toBe("Updated through the Node-owned Chat path");
    const [finalAuthority] = await db!.select().from(organizationBrandingMutationState)
      .where(eq(organizationBrandingMutationState.orgId, nodeOrgId));
    expect(finalAuthority).toMatchObject({ owner: "node", fenceEpoch: 0n });
    expect(finalAuthority).toEqual(initialAuthority);
    expect(await db!.select().from(organizationBrandingMutationReceipts)
      .where(eq(organizationBrandingMutationReceipts.orgId, nodeOrgId))).toHaveLength(0);

    const [resolvedProposal] = await db!.select().from(chatMessages)
      .where(eq(chatMessages.id, proposal.messageId));
    expect(resolvedProposal?.structuredPayload?.operationProposalState).toMatchObject({ status: "approved" });
    const appliedMessages = await db!.select().from(chatMessages).where(and(
      eq(chatMessages.conversationId, proposal.conversationId),
      eq(chatMessages.kind, "system_event"),
    ));
    expect(appliedMessages).toHaveLength(1);
    expect(appliedMessages[0]).toMatchObject({
      role: "system",
      structuredPayload: expect.objectContaining({
        eventType: "operation_applied",
        sourceMessageId: proposal.messageId,
        targetId: nodeOrgId,
      }),
    });
    const nodeAudits = await db!.select().from(activityLog).where(and(
      eq(activityLog.orgId, nodeOrgId),
      eq(activityLog.action, "organization.updated"),
      eq(activityLog.entityId, nodeOrgId),
    ));
    expect(nodeAudits).toHaveLength(1);
    expect(nodeAudits[0]).toMatchObject({
      details: expect.objectContaining({ source: "chat_lightweight_change", sourceMessageId: proposal.messageId }),
    });
    emitRealEntryEvidence("node-owned-non-branding-proposal", {
      fixture: {
        organizationId: nodeOrgId,
        conversationId: proposal.conversationId,
        proposalMessageId: proposal.messageId,
      },
      readback: {
        responseStatus,
        brandingBridgeCalls,
        organizationName: updatedOrganization?.name,
        authorityBefore: initialAuthority,
        authorityAfter: finalAuthority,
        brandingReceiptCount: 0,
        systemEventIds: appliedMessages.map(({ id }) => id),
        activityIds: nodeAudits.map(({ id }) => id),
      },
    });
  }, 60_000);

  it("rejects non-CEO and foreign-organization CEO branding proposals without side effects", async () => {
    const sameOrgId = await seedOrganization("Non-CEO branding target");
    const foreignTargetOrgId = await seedOrganization("Foreign CEO branding target");
    const foreignAgentOrgId = await seedOrganization("Foreign CEO agent organization");
    const nonCeoToken = `chat-branding-non-ceo-${randomUUID()}`;
    const foreignCeoToken = `chat-branding-foreign-ceo-${randomUUID()}`;
    const nonCeoAgentId = await seedAgent(sameOrgId, "general", nonCeoToken);
    const foreignCeoAgentId = await seedAgent(foreignAgentOrgId, "ceo", foreignCeoToken);
    const nonCeoProposal = await seedConversationForOrganization(
      sameOrgId,
      { brandColor: "#112233" },
      "Reject same-organization non-CEO branding",
    );
    const foreignCeoProposal = await seedConversationForOrganization(
      foreignTargetOrgId,
      { brandColor: "#445566" },
      "Reject foreign-organization CEO branding",
    );
    const originalOrganizationStates = new Map<string, { name: string; brandColor: string | null }>();
    for (const targetOrgId of [sameOrgId, foreignTargetOrgId]) {
      const [organization] = await db!.select({
        name: organizations.name,
        brandColor: organizations.brandColor,
      }).from(organizations).where(eq(organizations.id, targetOrgId));
      if (organization) originalOrganizationStates.set(targetOrgId, organization);
    }
    const readDenialEffectsSnapshot = async (targetOrgIds: string[]) => Promise.all(
      targetOrgIds.map(async (targetOrgId) => {
        const [organization] = await db!.select().from(organizations)
          .where(eq(organizations.id, targetOrgId));
        const [authority] = await db!.select().from(organizationBrandingMutationState)
          .where(eq(organizationBrandingMutationState.orgId, targetOrgId));
        const proposalsAndSystemEvents = await db!.select().from(chatMessages).where(and(
          eq(chatMessages.orgId, targetOrgId),
          inArray(chatMessages.kind, ["operation_proposal", "system_event"]),
        )).orderBy(asc(chatMessages.id));
        return {
          orgId: targetOrgId,
          organization: organization ?? null,
          authority: authority ?? null,
          receipts: await db!.select().from(organizationBrandingMutationReceipts)
            .where(eq(organizationBrandingMutationReceipts.orgId, targetOrgId))
            .orderBy(asc(organizationBrandingMutationReceipts.idempotencyKey)),
          activities: await db!.select().from(activityLog)
            .where(eq(activityLog.orgId, targetOrgId))
            .orderBy(asc(activityLog.id)),
          outbox: await db!.select().from(organizationMutationOutbox)
            .where(eq(organizationMutationOutbox.orgId, targetOrgId))
            .orderBy(asc(organizationMutationOutbox.id)),
          proposals: proposalsAndSystemEvents.filter(({ kind }) => kind === "operation_proposal"),
          systemEvents: proposalsAndSystemEvents.filter(({ kind }) => kind === "system_event"),
        };
      }),
    );
    const summarizeDenialSnapshot = (snapshot: Awaited<ReturnType<typeof readDenialEffectsSnapshot>>) =>
      snapshot.map(({ orgId: snapshotOrgId, organization, authority, receipts, activities, outbox, proposals, systemEvents }) => ({
        orgId: snapshotOrgId,
        organizationId: organization?.id ?? null,
        authority: authority && {
          owner: authority.owner,
          mutationVersion: authority.mutationVersion,
          fenceEpoch: authority.fenceEpoch,
          fenceToken: authority.fenceToken,
          updatedAt: authority.updatedAt,
        },
        receiptKeys: receipts.map(({ idempotencyKey: key }) => key),
        activityIds: activities.map(({ id }) => id),
        outboxIds: outbox.map(({ id }) => id),
        proposalStates: proposals.map(({ id, structuredPayload }) => ({
          messageId: id,
          state: structuredPayload?.operationProposalState,
        })),
        systemEventIds: systemEvents.map(({ id }) => id),
      }));
    const nonCeoSnapshotBefore = await readDenialEffectsSnapshot([sameOrgId]);
    const nonCeoProposalBefore = nonCeoSnapshotBefore[0]?.proposals.find(({ id }) => id === nonCeoProposal.messageId);
    expect(nonCeoSnapshotBefore[0]?.authority).toMatchObject({
      owner: "node",
      mutationVersion: 0n,
      fenceEpoch: 0n,
      fenceToken: expect.any(String),
      updatedAt: expect.any(Date),
    });
    expect(nonCeoProposalBefore?.structuredPayload?.operationProposalState)
      .toMatchObject({ status: "pending" });

    const foreignAuthorityOrgIds = [foreignTargetOrgId, foreignAgentOrgId];
    const foreignSnapshotBefore = await readDenialEffectsSnapshot(foreignAuthorityOrgIds);
    const foreignCeoProposalBefore = foreignSnapshotBefore[0]?.proposals.find(({ id }) => id === foreignCeoProposal.messageId);
    expect(foreignSnapshotBefore.map(({ authority }) => authority)).toEqual([
      expect.objectContaining({
        owner: "node",
        mutationVersion: 0n,
        fenceEpoch: 0n,
        fenceToken: expect.any(String),
        updatedAt: expect.any(Date),
      }),
      expect.objectContaining({
        owner: "node",
        mutationVersion: 0n,
        fenceEpoch: 0n,
        fenceToken: expect.any(String),
        updatedAt: expect.any(Date),
      }),
    ]);
    expect(foreignSnapshotBefore.map(({ receipts, activities, outbox, systemEvents }) => ({
      receipts,
      activities,
      outbox,
      systemEvents,
    }))).toEqual([
      { receipts: [], activities: [], outbox: [], systemEvents: [] },
      { receipts: [], activities: [], outbox: [], systemEvents: [] },
    ]);
    expect(foreignCeoProposalBefore?.structuredPayload?.operationProposalState)
      .toMatchObject({ status: "pending" });

    const previousSelection = process.env.RUDDER_RUST_ORGANIZATION_BRANDING_ORG_IDS;
    process.env.RUDDER_RUST_ORGANIZATION_BRANDING_ORG_IDS = [sameOrgId, foreignTargetOrgId].join(",");
    const directBridge = bridge!.organizationBrandingForActor.bind(bridge);
    let brandingBridgeCalls = 0;
    bridge!.organizationBrandingForActor = async (...args) => {
      brandingBridgeCalls += 1;
      return directBridge(...args);
    };

    let nonCeoResponseStatus: number | undefined;
    let foreignCeoResponseStatus: number | undefined;
    let nonCeoSnapshotAfter: Awaited<ReturnType<typeof readDenialEffectsSnapshot>> = [];
    let foreignSnapshotAfter: Awaited<ReturnType<typeof readDenialEffectsSnapshot>> = [];
    try {
      const nonCeoResponse = await request(server!)
        .post(`/api/chats/${nonCeoProposal.conversationId}/messages/${nonCeoProposal.messageId}/operation-proposal/resolve`)
        .set("authorization", `Bearer ${nonCeoToken}`)
        .send({ action: "approve", decisionNote: "Must be denied" });
      expect(nonCeoResponse.status, JSON.stringify(nonCeoResponse.body)).toBe(403);
      nonCeoResponseStatus = nonCeoResponse.status;
      nonCeoSnapshotAfter = await readDenialEffectsSnapshot([sameOrgId]);
      expect(nonCeoSnapshotAfter).toEqual(nonCeoSnapshotBefore);

      const foreignCeoResponse = await request(server!)
        .post(`/api/chats/${foreignCeoProposal.conversationId}/messages/${foreignCeoProposal.messageId}/operation-proposal/resolve`)
        .set("authorization", `Bearer ${foreignCeoToken}`)
        .send({ action: "approve", decisionNote: "Must be denied" });
      expect(foreignCeoResponse.status, JSON.stringify(foreignCeoResponse.body)).toBe(403);
      foreignCeoResponseStatus = foreignCeoResponse.status;
      foreignSnapshotAfter = await readDenialEffectsSnapshot(foreignAuthorityOrgIds);
      expect(foreignSnapshotAfter).toEqual(foreignSnapshotBefore);
    } finally {
      bridge!.organizationBrandingForActor = directBridge;
      if (previousSelection === undefined) delete process.env.RUDDER_RUST_ORGANIZATION_BRANDING_ORG_IDS;
      else process.env.RUDDER_RUST_ORGANIZATION_BRANDING_ORG_IDS = previousSelection;
    }

    expect(brandingBridgeCalls).toBe(0);
    for (const [targetOrgId, proposal] of [
      [sameOrgId, nonCeoProposal],
      [foreignTargetOrgId, foreignCeoProposal],
    ] as const) {
      const [organization] = await db!.select({
        name: organizations.name,
        brandColor: organizations.brandColor,
      }).from(organizations).where(eq(organizations.id, targetOrgId));
      expect(organization).toEqual(originalOrganizationStates.get(targetOrgId));
      const [authority] = await db!.select({
        owner: organizationBrandingMutationState.owner,
        fenceEpoch: organizationBrandingMutationState.fenceEpoch,
      }).from(organizationBrandingMutationState)
        .where(eq(organizationBrandingMutationState.orgId, targetOrgId));
      expect(authority).toMatchObject({ owner: "node", fenceEpoch: 0n });
      const [message] = await db!.select().from(chatMessages)
        .where(eq(chatMessages.id, proposal.messageId));
      expect(message?.structuredPayload?.operationProposalState).toMatchObject({ status: "pending" });
      expect(await db!.select().from(organizationBrandingMutationReceipts)
        .where(eq(organizationBrandingMutationReceipts.orgId, targetOrgId))).toHaveLength(0);
      expect(await db!.select().from(chatMessages).where(and(
        eq(chatMessages.conversationId, proposal.conversationId),
        eq(chatMessages.kind, "system_event"),
      ))).toHaveLength(0);
      expect(await db!.select().from(activityLog)
        .where(eq(activityLog.orgId, targetOrgId))).toHaveLength(0);
    }
    emitRealEntryEvidence("denied-branding-proposals", {
      fixture: {
        nonCeoOrganizationId: sameOrgId,
        nonCeoAgentId,
        nonCeoConversationId: nonCeoProposal.conversationId,
        nonCeoProposalMessageId: nonCeoProposal.messageId,
        foreignTargetOrganizationId: foreignTargetOrgId,
        foreignAgentOrganizationId: foreignAgentOrgId,
        foreignCeoAgentId,
        foreignCeoConversationId: foreignCeoProposal.conversationId,
        foreignCeoProposalMessageId: foreignCeoProposal.messageId,
      },
      readback: {
        nonCeoResponseStatus,
        foreignCeoResponseStatus,
        brandingBridgeCalls,
        nonCeoBefore: summarizeDenialSnapshot(nonCeoSnapshotBefore),
        nonCeoAfter: summarizeDenialSnapshot(nonCeoSnapshotAfter),
        foreignBefore: summarizeDenialSnapshot(foreignSnapshotBefore),
        foreignAfter: summarizeDenialSnapshot(foreignSnapshotAfter),
      },
    });
  }, 60_000);

  it("hands off a fresh Node-owned organization through the public Chat branding proposal", async () => {
    const freshOrgId = await seedOrganization("Fresh Node-owned branding target");
    await db!.insert(organizationMemberships).values({
      orgId: freshOrgId,
      principalType: "user",
      principalId: boardUserId,
      status: "active",
      membershipRole: "admin",
    });
    const proposalSummary = "Apply branding and hand off the fresh organization";
    const proposal = await seedConversationForOrganization(
      freshOrgId,
      { brandColor: "#778899" },
      proposalSummary,
    );
    const proposalKey = idempotencyKey("chat-proposal", proposal.messageId);
    const nodeAuditKey = `chat-proposal:${proposal.messageId}:organization-activity`;
    const [initialAuthority] = await db!.select().from(organizationBrandingMutationState)
      .where(eq(organizationBrandingMutationState.orgId, freshOrgId));
    expect(initialAuthority).toMatchObject({
      owner: "node",
      mutationVersion: 0n,
      fenceEpoch: 0n,
      fenceToken: expect.any(String),
      updatedAt: expect.any(Date),
    });
    const [proposalBeforeApproval] = await db!.select().from(chatMessages)
      .where(eq(chatMessages.id, proposal.messageId));
    expect(proposalBeforeApproval).toMatchObject({
      id: proposal.messageId,
      orgId: freshOrgId,
      conversationId: proposal.conversationId,
      role: "assistant",
      kind: "operation_proposal",
      body: proposalSummary,
      structuredPayload: {
        operationProposal: {
          targetType: "organization",
          targetId: freshOrgId,
          summary: proposalSummary,
          patch: { brandColor: "#778899" },
        },
        operationProposalState: {
          status: "pending",
          decisionNote: null,
          decidedByUserId: null,
          decidedAt: null,
        },
      },
    });
    const outboxBeforeApproval = await db!.select().from(organizationMutationOutbox)
      .where(eq(organizationMutationOutbox.orgId, freshOrgId))
      .orderBy(asc(organizationMutationOutbox.id));
    expect(outboxBeforeApproval).toEqual([]);

    const previousSelection = process.env.RUDDER_RUST_ORGANIZATION_BRANDING_ORG_IDS;
    process.env.RUDDER_RUST_ORGANIZATION_BRANDING_ORG_IDS = freshOrgId;
    let responseStatus: number | undefined;
    let responseBody: unknown;
    try {
      const response = await request(server!)
        .post(`/api/chats/${proposal.conversationId}/messages/${proposal.messageId}/operation-proposal/resolve`)
        .set("authorization", `Bearer ${boardToken}`)
        .send({ action: "approve", decisionNote: "Apply the requested branding" });
      responseStatus = response.status;
      responseBody = response.body;
    } finally {
      if (previousSelection === undefined) delete process.env.RUDDER_RUST_ORGANIZATION_BRANDING_ORG_IDS;
      else process.env.RUDDER_RUST_ORGANIZATION_BRANDING_ORG_IDS = previousSelection;
    }

    expect(responseStatus, JSON.stringify(responseBody)).toBe(201);
    const [updatedOrganization] = await db!.select({
      brandColor: organizations.brandColor,
    }).from(organizations).where(eq(organizations.id, freshOrgId));
    expect(updatedOrganization?.brandColor).toBe("#778899");
    const [finalAuthority] = await db!.select().from(organizationBrandingMutationState)
      .where(eq(organizationBrandingMutationState.orgId, freshOrgId));
    expect(finalAuthority).toMatchObject({
      owner: "rust",
      mutationVersion: 1n,
      fenceEpoch: 1n,
      fenceToken: expect.any(String),
      updatedAt: expect.any(Date),
    });
    expect(finalAuthority?.fenceToken).not.toBe(initialAuthority?.fenceToken);
    expect(finalAuthority?.updatedAt.getTime()).toBeGreaterThanOrEqual(initialAuthority!.updatedAt.getTime());

    const [finalProposalMessage] = await db!.select().from(chatMessages)
      .where(eq(chatMessages.id, proposal.messageId));
    expect(finalProposalMessage).toMatchObject({
      id: proposal.messageId,
      orgId: freshOrgId,
      conversationId: proposal.conversationId,
      role: "assistant",
      kind: "operation_proposal",
      body: proposalSummary,
      structuredPayload: {
        operationProposal: proposalBeforeApproval?.structuredPayload?.operationProposal,
        operationProposalState: {
          status: "approved",
          decisionNote: "Apply the requested branding",
          decidedByUserId: boardUserId,
          decidedAt: expect.any(String),
        },
      },
    });
    expect(finalProposalMessage?.approvalId).toBe(proposalBeforeApproval?.approvalId);
    expect(finalProposalMessage?.status).toBe(proposalBeforeApproval?.status);
    expect(finalProposalMessage?.createdAt).toEqual(proposalBeforeApproval?.createdAt);

    const receipts = await db!.select().from(organizationBrandingMutationReceipts).where(and(
      eq(organizationBrandingMutationReceipts.orgId, freshOrgId),
      eq(organizationBrandingMutationReceipts.idempotencyKey, proposalKey),
    ));
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      orgId: freshOrgId,
      idempotencyKey: proposalKey,
      outcome: "applied",
      fenceEpoch: 1n,
    });
    const rustActivities = await db!.select().from(activityLog).where(and(
      eq(activityLog.orgId, freshOrgId),
      eq(activityLog.action, "organization.branding_updated"),
      eq(activityLog.entityId, freshOrgId),
    ));
    expect(rustActivities).toHaveLength(1);
    expect(rustActivities[0]).toMatchObject({
      id: receipts[0]!.activityId,
      actorType: "user",
      actorId: boardUserId,
      entityType: "organization",
      entityId: freshOrgId,
    });
    const outboxAfterApproval = await db!.select().from(organizationMutationOutbox)
      .where(eq(organizationMutationOutbox.orgId, freshOrgId))
      .orderBy(asc(organizationMutationOutbox.id));
    expect(outboxAfterApproval).toEqual([
      expect.objectContaining({
        orgId: freshOrgId,
        activityId: receipts[0]!.activityId,
        eventType: "activity.logged",
        payload: {
          actorType: "user",
          actorId: boardUserId,
          action: "organization.branding_updated",
          entityType: "organization",
          entityId: freshOrgId,
          agentId: null,
          runId: null,
          details: rustActivities[0]!.details,
        },
      }),
    ]);
    const appliedMessages = await db!.select().from(chatMessages).where(and(
      eq(chatMessages.conversationId, proposal.conversationId),
      eq(chatMessages.kind, "system_event"),
    ));
    expect(appliedMessages).toHaveLength(1);
    expect(appliedMessages[0]).toMatchObject({
      role: "system",
      structuredPayload: expect.objectContaining({
        eventType: "operation_applied",
        sourceMessageId: proposal.messageId,
        targetId: freshOrgId,
      }),
    });
    const nodeAudits = await db!.select().from(activityLog).where(and(
      eq(activityLog.orgId, freshOrgId),
      eq(activityLog.action, "organization.updated"),
      eq(activityLog.entityId, freshOrgId),
      eq(activityLog.idempotencyKey, nodeAuditKey),
    ));
    expect(nodeAudits).toHaveLength(1);
    emitRealEntryEvidence("fresh-node-to-rust-handoff", {
      fixture: {
        organizationId: freshOrgId,
        conversationId: proposal.conversationId,
        proposalMessageId: proposal.messageId,
      },
      readback: {
        responseStatus,
        organizationBrandColor: updatedOrganization?.brandColor,
        authority: finalAuthority,
        receipt: {
          idempotencyKey: receipts[0]?.idempotencyKey,
          activityId: receipts[0]?.activityId,
          outcome: receipts[0]?.outcome,
        },
        activityId: rustActivities[0]?.id,
        outbox: outboxAfterApproval.map(({ id, eventType, activityId, payload }) => ({
          id,
          eventType,
          activityId,
          payload,
        })),
        systemEventIds: appliedMessages.map(({ id }) => id),
        nodeAuditIds: nodeAudits.map(({ id }) => id),
      },
    });
  }, 60_000);
});
