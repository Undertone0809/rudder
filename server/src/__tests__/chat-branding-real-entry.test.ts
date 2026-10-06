import {
  activityLog,
  approvals,
  applyPendingMigrations,
  authUsers,
  boardApiKeys,
  chatConversations,
  chatMessages,
  createDb,
  ensurePostgresDatabase,
  organizationBrandingMutationReceipts,
  organizationBrandingMutationState,
  organizationMemberships,
  organizations,
} from "@rudderhq/db";
import { deriveOrganizationUrlKey } from "@rudderhq/shared";
import { and, eq } from "drizzle-orm";
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
import { chatRoutes } from "../routes/chats.js";
import { createChatBackgroundRuntime } from "../routes/chat-background-runtime.js";
import type { StorageService } from "../storage/types.js";
import { handoffOrganizationBrandingAuthority } from "../services/organization-branding-fence.js";
import { createRustFoundationBridge, type RustFoundationBridge } from "../services/rust-foundation-bridge.js";

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
    expect(await db!.select().from(activityLog).where(and(
      eq(activityLog.orgId, orgId),
      eq(activityLog.action, "organization.branding_updated"),
    ))).toHaveLength(2);
  }, 60_000);
});
