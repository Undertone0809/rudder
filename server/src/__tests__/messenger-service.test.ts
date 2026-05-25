import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  applyPendingMigrations,
  agents,
  approvalComments,
  approvals,
  assets,
  chatConversations,
  chatMessages,
  createDb,
  documents,
  ensurePostgresDatabase,
  heartbeatRuns,
  invites,
  issueFollows,
  issueComments,
  issueDocuments,
  issues,
  joinRequests,
  messengerThreadUserStates,
  organizations,
} from "@rudderhq/db";
import { deriveOrganizationUrlKey } from "@rudderhq/shared";
import { issueService } from "../services/issues.ts";
import { chatService } from "../services/chats.ts";
import { messengerService } from "../services/messenger.ts";

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

async function getEmbeddedPostgresCtor(): Promise<EmbeddedPostgresCtor> {
  const mod = await import("embedded-postgres");
  return mod.default as EmbeddedPostgresCtor;
}

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
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

function getExternalDatabaseUrl(): string | null {
  return process.env.RUDDER_MESSENGER_SERVICE_TEST_DATABASE_URL?.trim() || null;
}

async function startTempDatabase() {
  const externalDatabaseUrl = getExternalDatabaseUrl();
  if (externalDatabaseUrl) {
    await applyPendingMigrations(externalDatabaseUrl);
    return { connectionString: externalDatabaseUrl, dataDir: "", instance: null };
  }

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-messenger-service-"));
  const port = await getAvailablePort();
  const EmbeddedPostgres = await getEmbeddedPostgresCtor();
  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "rudder",
    password: "rudder",
    port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: (message) => console.log(message),
    onError: (message) => console.error(message),
  });
  await instance.initialise();
  await instance.start();

  const adminConnectionString = `postgres://rudder:rudder@127.0.0.1:${port}/postgres`;
  await ensurePostgresDatabase(adminConnectionString, "rudder");
  const connectionString = `postgres://rudder:rudder@127.0.0.1:${port}/rudder`;
  await applyPendingMigrations(connectionString);
  return { connectionString, dataDir, instance };
}

describe("messengerService and issue follows", () => {
  let db!: ReturnType<typeof createDb>;
  let chatSvc!: ReturnType<typeof chatService>;
  let issueSvc!: ReturnType<typeof issueService>;
  let messengerSvc!: ReturnType<typeof messengerService>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    chatSvc = chatService(db);
    issueSvc = issueService(db);
    messengerSvc = messengerService(db);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueFollows);
    await db.delete(messengerThreadUserStates);
    await db.delete(chatMessages);
    await db.delete(chatConversations);
    await db.delete(assets);
    await db.delete(approvalComments);
    await db.delete(approvals);
    await db.delete(heartbeatRuns);
    await db.delete(joinRequests);
    await db.delete(invites);
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(organizations);
  });

  afterAll(async () => {
    await instance?.stop();
    if (dataDir) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("persists follows and includes followed plus assigned issues in the Messenger issues thread", async () => {
    const orgId = randomUUID();
    const userId = "board-user-1";
    const followedIssueId = randomUUID();
    const assignedIssueId = randomUUID();
    const createdIssueId = randomUUID();
    const unrelatedIssueId = randomUUID();
    const commentingAgentId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Org",
      urlKey: deriveOrganizationUrlKey("Messenger Org"),
      issuePrefix: `M${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: commentingAgentId,
      orgId,
      name: "Build Agent",
      role: "engineer",
      status: "active",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values([
      {
        id: followedIssueId,
        orgId,
        title: "Followed issue",
        status: "todo",
        priority: "medium",
      },
      {
        id: assignedIssueId,
        orgId,
        title: "Assigned issue",
        status: "todo",
        priority: "medium",
        assigneeUserId: userId,
      },
      {
        id: createdIssueId,
        orgId,
        title: "Created issue",
        status: "todo",
        priority: "medium",
        createdByUserId: userId,
      },
      {
        id: unrelatedIssueId,
        orgId,
        title: "Unrelated issue",
        status: "todo",
        priority: "medium",
      },
    ]);

    const followedCommentBody = [
      "## Review Summary",
      "",
      "- render enough comment body to judge the issue update",
      "- preserve markdown for Messenger issue previews",
    ].join("\n");

    await issueSvc.followIssue(orgId, followedIssueId, userId);
    const followedComment = await issueSvc.addComment(followedIssueId, followedCommentBody, { agentId: commentingAgentId });
    expect(await issueSvc.isFollowedByUser(orgId, followedIssueId, userId)).toBe(true);

    const thread = await messengerSvc.getIssuesThread(orgId, userId);
    const itemIds = new Set(thread.detail.items.map((item) => item.issueId));
    const followedItem = thread.detail.items.find((item) => item.issueId === followedIssueId);
    const assignedItem = thread.detail.items.find((item) => item.issueId === assignedIssueId);
    const createdItem = thread.detail.items.find((item) => item.issueId === createdIssueId);
    const summaries = await messengerSvc.listThreadSummaries(orgId, userId);
    const issuesSummary = summaries.find((item) => item.threadKey === "issues");

    expect(itemIds.has(followedIssueId)).toBe(true);
    expect(itemIds.has(assignedIssueId)).toBe(true);
    expect(itemIds.has(createdIssueId)).toBe(true);
    expect(itemIds.has(unrelatedIssueId)).toBe(false);
    expect(followedItem?.sourceCommentId).toBe(followedComment.id);
    expect(followedItem?.sourceCommentBody).toBe(followedCommentBody);
    expect(followedItem?.sourceCommentAuthorLabel).toBe("Build Agent");
    expect(followedItem?.metadata).toMatchObject({
      sourceCommentAuthorKind: "agent",
      sourceCommentByMe: false,
      sourceCommentAuthorLabel: "Build Agent",
    });
    expect(followedItem?.preview).toBe("Review Summary: render enough comment body to judge the issue update");
    expect(assignedItem?.metadata).toMatchObject({ assignedToMe: true, createdByMe: false });
    expect(assignedItem?.body).toContain("assigned to me");
    expect(createdItem?.metadata).toMatchObject({ assignedToMe: false, createdByMe: true });
    expect(issuesSummary?.preview).toBe("Followed issue — Review Summary: render enough comment body to judge the issue update");
  });

  it("includes issue status transitions in Messenger issue update cards", async () => {
    const orgId = randomUUID();
    const userId = "board-user-status-transition";
    const issueId = randomUUID();
    const activityAt = new Date("2026-04-20T10:00:00.000Z");

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Status Org",
      urlKey: deriveOrganizationUrlKey("Messenger Status Org"),
      issuePrefix: `S${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      orgId,
      title: "Status transition issue",
      status: "in_review",
      priority: "medium",
      createdByUserId: userId,
      updatedAt: activityAt,
    });

    await db.insert(activityLog).values({
      orgId,
      actorType: "system",
      actorId: "system",
      action: "issue.updated",
      entityType: "issue",
      entityId: issueId,
      details: {
        status: "in_review",
        _previous: { status: "todo" },
      },
      createdAt: activityAt,
    });

    const thread = await messengerSvc.getIssuesThread(orgId, userId);
    const item = thread.detail.items.find((entry) => entry.issueId === issueId);
    const summaries = await messengerSvc.listThreadSummaries(orgId, userId);
    const issuesSummary = summaries.find((entry) => entry.threadKey === "issues");

    expect(item?.preview).toBe("Status changed to in review");
    expect(item?.metadata).toMatchObject({
      status: "in_review",
      statusChange: { from: "todo", to: "in_review" },
    });
    expect(issuesSummary?.preview).toBe("Status transition issue — Status changed to in review");
  });

  it("keeps status transition metadata on comment-backed issue update cards", async () => {
    const orgId = randomUUID();
    const userId = "board-user-comment-status";
    const issueId = randomUUID();
    const activityAt = new Date("2026-04-20T11:00:00.000Z");

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Comment Status Org",
      urlKey: deriveOrganizationUrlKey("Messenger Comment Status Org"),
      issuePrefix: `C${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      orgId,
      title: "Comment-backed status issue",
      status: "blocked",
      priority: "medium",
      createdByUserId: userId,
      updatedAt: activityAt,
    });

    const comment = await issueSvc.addComment(issueId, "Blocked on design review.", { authorAgentId: null });
    await db.update(issueComments).set({ createdAt: activityAt }).where(eq(issueComments.id, comment.id));

    await db.insert(activityLog).values({
      orgId,
      actorType: "system",
      actorId: "system",
      action: "issue.updated",
      entityType: "issue",
      entityId: issueId,
      details: {
        status: "blocked",
        source: "comment",
        _previous: { status: "in_review" },
      },
      createdAt: activityAt,
    });

    const thread = await messengerSvc.getIssuesThread(orgId, userId);
    const item = thread.detail.items.find((entry) => entry.issueId === issueId);

    expect(item?.sourceCommentId).toBe(comment.id);
    expect(item?.sourceCommentBody).toBe("Blocked on design review.");
    expect(item?.sourceCommentAuthorLabel).toBe("System");
    expect(item?.preview).toBe("Blocked on design review.");
    expect(item?.metadata).toMatchObject({
      status: "blocked",
      statusChange: { from: "in_review", to: "blocked" },
      sourceCommentAuthorKind: "system",
      sourceCommentByMe: false,
      sourceCommentAuthorLabel: "System",
    });
  });

  it("preserves chat attachments when editing a user message into a new turn variant", async () => {
    const orgId = randomUUID();
    const conversationId = randomUUID();
    const userId = "board-user-edit-attachments";

    await db.insert(organizations).values({
      id: orgId,
      name: "Chat Attachment Org",
      urlKey: deriveOrganizationUrlKey("Chat Attachment Org"),
      issuePrefix: `C${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Attachment edit",
      issueCreationMode: "manual_approval",
      planMode: false,
      createdByUserId: userId,
    });

    const original = await chatSvc.addUserChatMessage(conversationId, orgId, "Original message");
    await chatSvc.createAttachment({
      orgId,
      conversationId,
      messageId: original.id,
      provider: "local_disk",
      objectKey: `orgs/${orgId}/chats/${conversationId}/${randomUUID()}/image.png`,
      contentType: "image/png",
      byteSize: 8,
      sha256: "sha256",
      originalFilename: "image.png",
      createdByAgentId: null,
      createdByUserId: userId,
    });

    const edited = await chatSvc.addUserChatMessage(
      conversationId,
      orgId,
      "Edited message",
      original.id,
    );
    const messages = await chatSvc.listMessages(conversationId);
    const originalAfterEdit = messages.find((message) => message.id === original.id);
    const editedAfterEdit = messages.find((message) => message.id === edited.id);

    expect(originalAfterEdit?.supersededAt).toBeInstanceOf(Date);
    expect(originalAfterEdit?.attachments).toHaveLength(1);
    expect(edited.attachments).toHaveLength(1);
    expect(editedAfterEdit?.attachments).toHaveLength(1);
    expect(editedAfterEdit?.attachments[0]?.assetId).toBe(originalAfterEdit?.attachments[0]?.assetId);
    expect(editedAfterEdit?.attachments[0]?.contentPath).toBe(originalAfterEdit?.attachments[0]?.contentPath);
  });

  it("does not mark a chat unread until an incoming message has visible content", async () => {
    const orgId = randomUUID();
    const conversationId = randomUUID();
    const userId = "board-user-visible-unread";

    await db.insert(organizations).values({
      id: orgId,
      name: "Chat Visible Unread Org",
      urlKey: deriveOrganizationUrlKey("Chat Visible Unread Org"),
      issuePrefix: `V${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Visible unread chat",
      issueCreationMode: "manual_approval",
      planMode: false,
      createdByUserId: userId,
    });

    await chatSvc.markRead(conversationId, orgId, userId, new Date("2026-05-01T00:00:00.000Z"));
    const placeholder = await chatSvc.addMessage(conversationId, {
      orgId,
      role: "assistant",
      kind: "message",
      status: "streaming",
      body: "",
    });

    const [afterPlaceholder] = await chatSvc.list(orgId, { status: "active" }, userId);
    expect(afterPlaceholder?.unreadCount).toBe(0);
    expect(afterPlaceholder?.needsAttention).toBe(false);
    expect(afterPlaceholder?.lastMessageAt).toBeNull();

    const visible = await chatSvc.updateMessage(conversationId, placeholder.id, {
      status: "streaming",
      body: "First visible assistant token",
    });
    expect(visible?.createdAt.getTime()).toBeGreaterThan(placeholder.createdAt.getTime());

    const [afterVisibleContent] = await chatSvc.list(orgId, { status: "active" }, userId);
    expect(afterVisibleContent?.unreadCount).toBe(1);
    expect(afterVisibleContent?.needsAttention).toBe(true);
    expect(afterVisibleContent?.latestReplyPreview).toBe("First visible assistant token");

    await chatSvc.markRead(conversationId, orgId, userId, new Date("2999-01-01T00:00:00.000Z"));
    await chatSvc.updateMessage(conversationId, placeholder.id, { status: "completed" });

    const [afterStatusOnlyUpdate] = await chatSvc.list(orgId, { status: "active" }, userId);
    expect(afterStatusOnlyUpdate?.unreadCount).toBe(0);
    expect(afterStatusOnlyUpdate?.needsAttention).toBe(false);
  });

  it("can mark a read chat unread by rewinding to the latest visible incoming message", async () => {
    const orgId = randomUUID();
    const conversationId = randomUUID();
    const userId = "board-user-mark-unread";

    await db.insert(organizations).values({
      id: orgId,
      name: "Chat Mark Unread Org",
      urlKey: deriveOrganizationUrlKey("Chat Mark Unread Org"),
      issuePrefix: `U${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Mark unread chat",
      issueCreationMode: "manual_approval",
      planMode: false,
      createdByUserId: userId,
    });

    await chatSvc.addUserChatMessage(conversationId, orgId, "User messages are not unread work.");
    await chatSvc.addMessage(conversationId, {
      orgId,
      role: "assistant",
      kind: "message",
      status: "completed",
      body: "Incoming assistant reply",
    });
    await chatSvc.markRead(conversationId, orgId, userId, new Date());

    const [afterRead] = await chatSvc.list(orgId, { status: "active" }, userId);
    expect(afterRead?.unreadCount).toBe(0);

    await chatSvc.markUnread(conversationId, orgId, userId);

    const [afterUnread] = await chatSvc.list(orgId, { status: "active" }, userId);
    expect(afterUnread?.unreadCount).toBe(1);
    expect(afterUnread?.isUnread).toBe(true);
    expect(afterUnread?.needsAttention).toBe(true);
  });

  it("clears chat attention after the current issue proposal approval is resolved", async () => {
    const orgId = randomUUID();
    const userId = "board-user-chat-resolved-proposal-attention";
    const revisionApprovalId = randomUUID();
    const currentApprovalId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Chat Resolved Proposal Attention Org",
      urlKey: deriveOrganizationUrlKey("Chat Resolved Proposal Attention Org"),
      issuePrefix: `CP${orgId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const conversation = await chatSvc.create(orgId, {
      title: "Resolve proposal attention",
      issueCreationMode: "manual_approval",
      planMode: false,
      createdByUserId: userId,
    });

    await db.insert(approvals).values([
      {
        id: revisionApprovalId,
        orgId,
        type: "chat_issue_creation",
        status: "revision_requested",
        requestedByUserId: userId,
        decisionNote: "Add architecture details.",
        payload: {
          chatConversationId: conversation!.id,
          proposedIssue: {
            title: "Initial proposal",
            description: "Needs more detail.",
            priority: "medium",
          },
        },
      },
      {
        id: currentApprovalId,
        orgId,
        type: "chat_issue_creation",
        status: "pending",
        requestedByUserId: userId,
        payload: {
          chatConversationId: conversation!.id,
          proposedIssue: {
            title: "Detailed proposal",
            description: "Includes architecture and rollout details.",
            priority: "medium",
          },
        },
      },
    ]);
    await db.insert(chatMessages).values([
      {
        orgId,
        conversationId: conversation!.id,
        role: "assistant",
        kind: "issue_proposal",
        body: "Initial proposal",
        approvalId: revisionApprovalId,
      },
      {
        orgId,
        conversationId: conversation!.id,
        role: "assistant",
        kind: "issue_proposal",
        body: "Detailed proposal",
        approvalId: currentApprovalId,
      },
    ]);
    await chatSvc.markRead(conversation!.id, orgId, userId, new Date("2999-01-01T00:00:00.000Z"));

    const [withPendingApproval] = await chatSvc.list(orgId, { status: "active" }, userId);
    expect(withPendingApproval?.unreadCount).toBe(0);
    expect(withPendingApproval?.needsAttention).toBe(true);

    await db
      .update(approvals)
      .set({
        status: "approved",
        decidedByUserId: userId,
        decidedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(approvals.id, currentApprovalId));

    const [afterCurrentApprovalResolved] = await chatSvc.list(orgId, { status: "active" }, userId);
    expect(afterCurrentApprovalResolved?.unreadCount).toBe(0);
    expect(afterCurrentApprovalResolved?.needsAttention).toBe(false);
  });

  it("searches chat conversations by title, summary, and message body without leaking organizations", async () => {
    const orgId = randomUUID();
    const otherOrgId = randomUUID();
    const titleChatId = randomUUID();
    const messageChatId = randomUUID();
    const summaryChatId = randomUUID();
    const otherOrgChatId = randomUUID();
    const userId = "board-user-chat-search";
    const olderAt = new Date("2026-05-01T10:00:00.000Z");
    const newerAt = new Date("2026-05-01T11:00:00.000Z");

    await db.insert(organizations).values([
      {
        id: orgId,
        name: "Chat Search Org",
        urlKey: deriveOrganizationUrlKey("Chat Search Org"),
        issuePrefix: `S${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherOrgId,
        name: "Other Chat Search Org",
        urlKey: deriveOrganizationUrlKey("Other Chat Search Org"),
        issuePrefix: `O${otherOrgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);

    await db.insert(chatConversations).values([
      {
        id: titleChatId,
        orgId,
        title: "Launch-token planning",
        status: "active",
        lastMessageAt: olderAt,
        createdAt: olderAt,
        updatedAt: olderAt,
      },
      {
        id: messageChatId,
        orgId,
        title: "Message body only",
        status: "active",
        lastMessageAt: newerAt,
        createdAt: newerAt,
        updatedAt: newerAt,
      },
      {
        id: summaryChatId,
        orgId,
        title: "Summary only",
        summary: "Retains the launch-token deployment summary",
        status: "resolved",
        lastMessageAt: new Date("2026-05-01T09:00:00.000Z"),
      },
      {
        id: otherOrgChatId,
        orgId: otherOrgId,
        title: "Launch-token private chat",
        status: "active",
        lastMessageAt: newerAt,
      },
    ]);

    await db.insert(chatMessages).values([
      {
        orgId,
        conversationId: messageChatId,
        role: "user",
        kind: "message",
        body: "The only match is the launch-token buried in a user message.",
        createdAt: newerAt,
        updatedAt: newerAt,
      },
      {
        orgId,
        conversationId: messageChatId,
        role: "assistant",
        kind: "message",
        body: "A second launch-token mention should not duplicate the conversation.",
        createdAt: new Date("2026-05-01T11:01:00.000Z"),
        updatedAt: new Date("2026-05-01T11:01:00.000Z"),
      },
      {
        orgId: otherOrgId,
        conversationId: otherOrgChatId,
        role: "assistant",
        kind: "message",
        body: "launch-token from another org",
        createdAt: newerAt,
        updatedAt: newerAt,
      },
    ]);

    const results = await chatSvc.list(orgId, { status: "all", q: "launch-token" }, userId);
    const ids = results.map((conversation) => conversation.id);

    expect(ids).toEqual([messageChatId, titleChatId, summaryChatId]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain(otherOrgChatId);
    expect(results.find((conversation) => conversation.id === titleChatId)?.searchPreview).toBe("Launch-token planning");
    expect(results.find((conversation) => conversation.id === summaryChatId)?.searchPreview).toBe("Retains the launch-token deployment summary");
    expect(results.find((conversation) => conversation.id === messageChatId)?.searchPreview).toContain("launch-token");
  });

  it("does not assign approved chat issue proposals to the selected chat agent by default", async () => {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const userId = "board-user-approval";

    await db.insert(organizations).values({
      id: orgId,
      name: "Chat Approval Assignee Org",
      urlKey: deriveOrganizationUrlKey("Chat Approval Assignee Org"),
      issuePrefix: `A${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Selected Engineer",
      role: "engineer",
      status: "idle",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const conversation = await chatSvc.create(orgId, {
      title: "Plan selected work",
      preferredAgentId: agentId,
      issueCreationMode: "manual_approval",
      planMode: false,
      createdByUserId: userId,
    });

    const approval = await db
      .insert(approvals)
      .values({
        orgId,
        type: "chat_issue_creation",
        status: "approved",
        requestedByUserId: userId,
        payload: {
          chatConversationId: conversation!.id,
          proposedIssue: {
            title: "Implement selected work",
            description: "The chat-selected agent should receive this approved issue.",
            priority: "medium",
            reviewerAgentId: agentId,
          },
        },
      })
      .returning()
      .then((rows) => rows[0]!);

    const issue = await chatSvc.applyApprovedApproval(approval, userId);
    const persistedIssue = await db
      .select({ assigneeAgentId: issues.assigneeAgentId, reviewerAgentId: issues.reviewerAgentId })
      .from(issues)
      .where(eq(issues.id, (issue as { id: string }).id))
      .then((rows) => rows[0]);

    expect(issue).toMatchObject({
      title: "Implement selected work",
      assigneeAgentId: null,
      reviewerAgentId: agentId,
      createdByUserId: userId,
    });
    expect(persistedIssue?.assigneeAgentId).toBeNull();
    expect(persistedIssue?.reviewerAgentId).toBe(agentId);
  });

  it("writes a plan document only after approving a plan-mode chat issue proposal", async () => {
    const orgId = randomUUID();
    const userId = "board-user-plan-approval";

    await db.insert(organizations).values({
      id: orgId,
      name: "Plan Approval Org",
      urlKey: deriveOrganizationUrlKey("Plan Approval Org " + orgId),
      issuePrefix: `PA${orgId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const conversation = await chatSvc.create(orgId, {
      title: "Plan before issue creation",
      issueCreationMode: "manual_approval",
      planMode: true,
      createdByUserId: userId,
    });

    const approval = await db
      .insert(approvals)
      .values({
        orgId,
        type: "chat_issue_creation",
        status: "approved",
        requestedByUserId: userId,
        payload: {
          chatConversationId: conversation!.id,
          proposedIssue: {
            title: "Implement planned work",
            description: "Create the issue only after approval.",
            priority: "high",
          },
          planDocument: {
            title: "Planned work rollout",
            body: "## Scope\n- Draft first\n- Create after approval",
            changeSummary: "Created from approved plan-mode proposal",
          },
        },
      })
      .returning()
      .then((rows) => rows[0]!);

    const issue = await chatSvc.applyApprovedApproval(approval, userId);
    const persistedPlan = await db
      .select({
        key: issueDocuments.key,
        title: documents.title,
        latestBody: documents.latestBody,
        createdByUserId: documents.createdByUserId,
      })
      .from(issueDocuments)
      .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
      .where(eq(issueDocuments.issueId, (issue as { id: string }).id))
      .then((rows) => rows[0]);

    expect(issue).toMatchObject({
      title: "Implement planned work",
      createdByUserId: userId,
    });
    expect(persistedPlan).toMatchObject({
      key: "plan",
      title: "Planned work rollout",
      latestBody: "## Scope\n- Draft first\n- Create after approval",
      createdByUserId: userId,
    });
  });

  it("includes reviewer issues in Messenger attention when they are in review", async () => {
    const orgId = randomUUID();
    const userId = "board-user-reviewer";
    const reviewerIssueId = randomUUID();
    const unrelatedIssueId = randomUUID();
    const reviewRequestedAt = new Date("2026-04-10T14:00:00.000Z");

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Reviewer Org",
      urlKey: deriveOrganizationUrlKey("Messenger Reviewer Org"),
      issuePrefix: `V${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values([
      {
        id: reviewerIssueId,
        orgId,
        title: "Reviewer issue",
        status: "in_review",
        priority: "medium",
        reviewerUserId: userId,
        createdAt: reviewRequestedAt,
        updatedAt: reviewRequestedAt,
      },
      {
        id: unrelatedIssueId,
        orgId,
        title: "Unrelated review issue",
        status: "in_review",
        priority: "medium",
        createdAt: reviewRequestedAt,
        updatedAt: reviewRequestedAt,
      },
    ]);

    const thread = await messengerSvc.getIssuesThread(orgId, userId);
    const summaries = await messengerSvc.listThreadSummaries(orgId, userId);
    const issuesSummary = summaries.find((item) => item.threadKey === "issues");
    const item = thread.detail.items.find((entry) => entry.issueId === reviewerIssueId);

    expect(thread.detail.items.map((entry) => entry.issueId)).toEqual([reviewerIssueId]);
    expect(item?.metadata).toMatchObject({ reviewerForMe: true, assignedToMe: false, createdByMe: false });
    expect(item?.body).toContain("review requested");
    expect(thread.detail.unreadCount).toBe(1);
    expect(thread.detail.needsAttention).toBe(true);
    expect(thread.summary.latestActivityAt?.toISOString()).toBe(reviewRequestedAt.toISOString());
    expect(issuesSummary?.latestActivityAt?.toISOString()).toBe(reviewRequestedAt.toISOString());
  });

  it("does not treat pre-review reviewer issues as review attention", async () => {
    const orgId = randomUUID();
    const userId = "board-user-pre-reviewer";
    const issueId = randomUUID();
    const updatedAt = new Date("2026-04-10T14:00:00.000Z");

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Pre Review Org",
      urlKey: deriveOrganizationUrlKey("Messenger Pre Review Org"),
      issuePrefix: `P${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      orgId,
      title: "Reviewer issue before review",
      status: "todo",
      priority: "medium",
      reviewerUserId: userId,
      createdAt: updatedAt,
      updatedAt,
    });

    const thread = await messengerSvc.getIssuesThread(orgId, userId);
    const item = thread.detail.items.find((entry) => entry.issueId === issueId);

    expect(item?.metadata).toMatchObject({ reviewerForMe: false });
    expect(item?.body).not.toContain("review requested");
    expect(thread.detail.unreadCount).toBe(0);
    expect(thread.detail.needsAttention).toBe(false);
  });

  it("does not count self-authored issue activity as Messenger attention", async () => {
    const orgId = randomUUID();
    const userId = "board-user-self-activity";
    const createdIssueId = randomUUID();
    const createdAt = new Date("2026-04-10T09:00:00.000Z");

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Self Activity Org",
      urlKey: deriveOrganizationUrlKey("Messenger Self Activity Org"),
      issuePrefix: `S${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: createdIssueId,
      orgId,
      title: "Self-created issue",
      status: "todo",
      priority: "medium",
      createdByUserId: userId,
      createdAt,
      updatedAt: createdAt,
    });

    await issueSvc.addComment(createdIssueId, "I already handled this", { userId });

    const thread = await messengerSvc.getIssuesThread(orgId, userId);
    const summaries = await messengerSvc.listThreadSummaries(orgId, userId);
    const issuesSummary = summaries.find((item) => item.threadKey === "issues");

    expect(thread.detail.items.map((item) => item.issueId)).toEqual([createdIssueId]);
    expect(thread.detail.items[0]?.preview).toBeNull();
    expect(thread.detail.items[0]?.body).not.toContain("I already handled this");
    expect(thread.detail.items[0]?.sourceCommentId).toBeNull();
    expect(thread.detail.items[0]?.sourceCommentAuthorLabel).toBeNull();
    expect(thread.detail.items[0]?.sourceCommentBody).toBeNull();
    expect(thread.detail.unreadCount).toBe(0);
    expect(thread.detail.needsAttention).toBe(false);
    expect(thread.summary.latestActivityAt).toBeNull();
    expect(thread.summary.preview).toBe("Cross-issue activity feed");
    expect(issuesSummary?.unreadCount).toBe(0);
    expect(issuesSummary?.needsAttention).toBe(false);
    expect(issuesSummary?.latestActivityAt).toBeNull();
  });

  it("includes the issue title in completion previews for unread Messenger issue notifications", async () => {
    const orgId = randomUUID();
    const userId = "board-user-completion-preview";
    const issueId = randomUUID();
    const completedAt = new Date("2026-04-10T15:00:00.000Z");

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Completion Preview Org",
      urlKey: deriveOrganizationUrlKey("Messenger Completion Preview Org"),
      issuePrefix: `C${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      orgId,
      title: "Explain completed notification",
      status: "done",
      priority: "medium",
      assigneeUserId: userId,
      identifier: "CMP-41",
      createdAt: completedAt,
      updatedAt: completedAt,
      completedAt,
    });

    await db.insert(activityLog).values({
      orgId,
      actorType: "agent",
      actorId: "completion-agent",
      action: "issue.updated",
      entityType: "issue",
      entityId: issueId,
      details: { status: "done", identifier: "CMP-41", _previous: { status: "in_progress" } },
      createdAt: completedAt,
    });

    const thread = await messengerSvc.getIssuesThread(orgId, userId);
    const summaries = await messengerSvc.listThreadSummaries(orgId, userId);
    const issuesSummary = summaries.find((item) => item.threadKey === "issues");
    const item = thread.detail.items.find((entry) => entry.issueId === issueId);

    expect(item?.preview).toBe("Completed");
    expect(thread.summary.preview).toBe("CMP-41 · Explain completed notification — Completed");
    expect(issuesSummary?.preview).toBe("CMP-41 · Explain completed notification — Completed");
    expect(thread.detail.unreadCount).toBe(1);
    expect(thread.detail.needsAttention).toBe(true);
  });

  it("does not count description-only issue updates as Messenger attention", async () => {
    const orgId = randomUUID();
    const userId = "board-user-description-only";
    const issueId = randomUUID();
    const createdAt = new Date("2026-04-10T09:00:00.000Z");
    const updatedAt = new Date("2026-04-10T10:00:00.000Z");

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Description Update Org",
      urlKey: deriveOrganizationUrlKey("Messenger Description Update Org"),
      issuePrefix: `D${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      orgId,
      title: "Description-only update issue",
      status: "todo",
      priority: "medium",
      assigneeUserId: userId,
      identifier: "DSC-1",
      createdAt,
      updatedAt,
    });

    await db.insert(activityLog).values({
      orgId,
      actorType: "agent",
      actorId: "description-agent",
      action: "issue.updated",
      entityType: "issue",
      entityId: issueId,
      details: { description: "New description", identifier: "DSC-1", _previous: { description: "Old description" } },
      createdAt: new Date("2026-04-10T10:00:01.000Z"),
    });

    const thread = await messengerSvc.getIssuesThread(orgId, userId);
    const summaries = await messengerSvc.listThreadSummaries(orgId, userId);
    const issuesSummary = summaries.find((item) => item.threadKey === "issues");
    const item = thread.detail.items.find((entry) => entry.issueId === issueId);

    expect(item?.metadata).toMatchObject({ assignedToMe: true });
    expect(thread.detail.unreadCount).toBe(0);
    expect(thread.detail.needsAttention).toBe(false);
    expect(thread.summary.latestActivityAt).toBeNull();
    expect(issuesSummary?.unreadCount).toBe(0);
    expect(issuesSummary?.needsAttention).toBe(false);
    expect(issuesSummary?.latestActivityAt).toBeNull();
  });

  it("does not count self-authored issue status updates as Messenger attention", async () => {
    const orgId = randomUUID();
    const userId = "board-user-self-status";
    const issueId = randomUUID();
    const createdAt = new Date("2026-04-10T09:00:00.000Z");
    const updatedAt = new Date("2026-04-10T10:00:00.000Z");

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Self Status Org",
      urlKey: deriveOrganizationUrlKey("Messenger Self Status Org"),
      issuePrefix: `U${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      orgId,
      title: "Self-updated status issue",
      status: "in_review",
      priority: "medium",
      createdByUserId: userId,
      createdAt,
      updatedAt,
    });

    await db.insert(activityLog).values({
      orgId,
      actorType: "user",
      actorId: userId,
      action: "issue.updated",
      entityType: "issue",
      entityId: issueId,
      details: { status: "in_review", _previous: { status: "todo" } },
      createdAt: updatedAt,
    });

    const thread = await messengerSvc.getIssuesThread(orgId, userId);
    const summaries = await messengerSvc.listThreadSummaries(orgId, userId);
    const issuesSummary = summaries.find((item) => item.threadKey === "issues");

    expect(thread.detail.items.map((item) => item.issueId)).toEqual([issueId]);
    expect(thread.detail.items[0]?.preview).toBe("Status changed to in review");
    expect(thread.detail.items[0]?.sourceCommentId).toBeNull();
    expect(thread.detail.items[0]?.sourceCommentAuthorLabel).toBeNull();
    expect(thread.detail.items[0]?.sourceCommentBody).toBeNull();
    expect(thread.detail.unreadCount).toBe(0);
    expect(thread.detail.needsAttention).toBe(false);
    expect(thread.summary.latestActivityAt).toBeNull();
    expect(issuesSummary?.unreadCount).toBe(0);
    expect(issuesSummary?.needsAttention).toBe(false);
    expect(issuesSummary?.latestActivityAt).toBeNull();
  });

  it("returns Messenger issue detail items in chronological order while keeping the summary pinned to latest activity", async () => {
    const orgId = randomUUID();
    const userId = "board-user-order";
    const olderIssueId = randomUUID();
    const newerIssueId = randomUUID();
    const olderActivityAt = new Date("2026-04-10T09:00:00.000Z");
    const newerActivityAt = new Date("2026-04-10T12:00:00.000Z");

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Order Org",
      urlKey: deriveOrganizationUrlKey("Messenger Order Org"),
      issuePrefix: `O${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values([
      {
        id: olderIssueId,
        orgId,
        title: "Older issue update",
        status: "todo",
        priority: "medium",
        assigneeUserId: userId,
        createdAt: olderActivityAt,
        updatedAt: olderActivityAt,
      },
      {
        id: newerIssueId,
        orgId,
        title: "Newer issue update",
        status: "todo",
        priority: "medium",
        assigneeUserId: userId,
        createdAt: newerActivityAt,
        updatedAt: newerActivityAt,
      },
    ]);

    const thread = await messengerSvc.getIssuesThread(orgId, userId);
    const summaries = await messengerSvc.listThreadSummaries(orgId, userId);
    const issuesSummary = summaries.find((item) => item.threadKey === "issues");

    expect(thread.detail.items.map((item) => item.issueId)).toEqual([olderIssueId, newerIssueId]);
    expect(thread.summary.latestActivityAt?.toISOString()).toBe(newerActivityAt.toISOString());
    expect(issuesSummary?.latestActivityAt?.toISOString()).toBe(newerActivityAt.toISOString());
  });

  it("returns Messenger approval detail items in chronological order while keeping the summary pinned to latest activity", async () => {
    const orgId = randomUUID();
    const userId = "board-user-approvals";
    const olderApprovalId = randomUUID();
    const newerApprovalId = randomUUID();
    const olderActivityAt = new Date("2026-04-11T09:00:00.000Z");
    const newerActivityAt = new Date("2026-04-11T12:00:00.000Z");

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Approvals Org",
      urlKey: deriveOrganizationUrlKey("Messenger Approvals Org"),
      issuePrefix: `A${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(approvals).values([
      {
        id: olderApprovalId,
        orgId,
        type: "hire_agent",
        status: "approved",
        requestedByUserId: userId,
        payload: { name: "Older approval" },
        createdAt: olderActivityAt,
        updatedAt: olderActivityAt,
      },
      {
        id: newerApprovalId,
        orgId,
        type: "hire_agent",
        status: "approved",
        requestedByUserId: userId,
        payload: { name: "Newer approval" },
        createdAt: newerActivityAt,
        updatedAt: newerActivityAt,
      },
    ]);

    const thread = await messengerSvc.getApprovalsThread(orgId, userId);
    const summaries = await messengerSvc.listThreadSummaries(orgId, userId);
    const approvalsSummary = summaries.find((item) => item.threadKey === "approvals");

    expect(thread.detail.items.map((item) => item.id)).toEqual([olderApprovalId, newerApprovalId]);
    expect(thread.summary.latestActivityAt?.toISOString()).toBe(newerActivityAt.toISOString());
    expect(approvalsSummary?.latestActivityAt?.toISOString()).toBe(newerActivityAt.toISOString());
  });

  it("summarizes approvals from latest comments without hydrating the detail thread", async () => {
    const orgId = randomUUID();
    const otherOrgId = randomUUID();
    const userId = "board-user-approval-summary-only";
    const pendingApprovalId = randomUUID();
    const approvedApprovalId = randomUUID();
    const otherOrgApprovalId = randomUUID();
    const pendingUpdatedAt = new Date("2026-04-11T11:00:00.000Z");
    const approvedUpdatedAt = new Date("2026-04-11T12:00:00.000Z");
    const latestCommentAt = new Date("2026-04-11T13:00:00.000Z");

    await db.insert(organizations).values([
      {
        id: orgId,
        name: "Messenger Approval Summary Only Org",
        urlKey: deriveOrganizationUrlKey("Messenger Approval Summary Only Org"),
        issuePrefix: `AS${orgId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherOrgId,
        name: "Other Approval Summary Org",
        urlKey: deriveOrganizationUrlKey("Other Approval Summary Org"),
        issuePrefix: `OA${otherOrgId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    await db.insert(approvals).values([
      {
        id: pendingApprovalId,
        orgId,
        type: "chat_issue_creation",
        status: "pending",
        requestedByUserId: userId,
        payload: {
          proposedIssue: {
            title: "Pending approval",
            description: "Needs review.",
            priority: "medium",
          },
        },
        createdAt: new Date("2026-04-11T10:00:00.000Z"),
        updatedAt: pendingUpdatedAt,
      },
      {
        id: approvedApprovalId,
        orgId,
        type: "hire_agent",
        status: "approved",
        requestedByUserId: userId,
        payload: { name: "Approved later" },
        createdAt: approvedUpdatedAt,
        updatedAt: approvedUpdatedAt,
      },
      {
        id: otherOrgApprovalId,
        orgId: otherOrgId,
        type: "hire_agent",
        status: "pending",
        requestedByUserId: userId,
        payload: { name: "Other org approval" },
        createdAt: latestCommentAt,
        updatedAt: latestCommentAt,
      },
    ]);
    await db.insert(approvalComments).values([
      {
        orgId,
        approvalId: pendingApprovalId,
        body: "Older approval comment should not drive the summary preview.",
        createdAt: new Date("2026-04-11T10:45:00.000Z"),
      },
      {
        orgId,
        approvalId: pendingApprovalId,
        body: "Latest approval comment drives the summary preview.",
        createdAt: latestCommentAt,
      },
      {
        orgId: otherOrgId,
        approvalId: otherOrgApprovalId,
        body: "Other org comment should not drive this summary.",
        createdAt: new Date("2026-04-11T14:00:00.000Z"),
      },
    ]);
    await messengerSvc.setThreadRead(orgId, userId, "approvals", new Date("2026-04-11T10:30:00.000Z"));

    const thread = await messengerSvc.getApprovalsThread(orgId, userId);
    const summaries = await messengerSvc.listThreadSummaries(orgId, userId);
    const approvalsSummary = summaries.find((item) => item.threadKey === "approvals");

    expect(thread.detail.items.map((item) => item.id)).toEqual([approvedApprovalId, pendingApprovalId]);
    expect(thread.detail.items.map((item) => item.id)).not.toContain(otherOrgApprovalId);
    expect(thread.summary.latestActivityAt?.toISOString()).toBe(latestCommentAt.toISOString());
    expect(thread.summary.preview).toBe("Latest approval comment drives the summary preview.");
    expect(thread.summary.unreadCount).toBe(1);
    expect(approvalsSummary?.subtitle).toBe("2 approvals");
    expect(approvalsSummary?.latestActivityAt?.toISOString()).toBe(latestCommentAt.toISOString());
    expect(approvalsSummary?.preview).toBe("Latest approval comment drives the summary preview.");
    expect(approvalsSummary?.unreadCount).toBe(1);
  });

  it("summarizes chat issue approvals without exposing raw payload ids", async () => {
    const orgId = randomUUID();
    const userId = "board-user-chat-approval-summary";
    const chatId = randomUUID();
    const projectId = randomUUID();
    const assigneeUserId = randomUUID();
    const approvalId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Chat Approval Summary Org",
      urlKey: deriveOrganizationUrlKey("Messenger Chat Approval Summary Org"),
      issuePrefix: `CA${orgId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(approvals).values({
      id: approvalId,
      orgId,
      type: "chat_issue_creation",
      status: "pending",
      requestedByUserId: userId,
      payload: {
        chatConversationId: chatId,
        proposedIssue: {
          title: "Fix approval review copy",
          description: "## Scope\nRender Markdown and readable assignee labels.",
          priority: "medium",
          projectId,
          assigneeUserId,
        },
      },
    });

    const thread = await messengerSvc.getApprovalsThread(orgId, userId);
    const item = thread.detail.items.find((approvalItem) => approvalItem.id === approvalId);

    expect(item?.title).toBe("Review proposed issue");
    expect(item?.preview).toContain("Fix approval review copy");
    expect(item?.preview).not.toContain(chatId);
    expect(item?.preview).not.toContain(projectId);
    expect(item?.preview).not.toContain(assigneeUserId);
  });

  it("returns Messenger failed-run detail items in chronological order while keeping the summary pinned to latest activity", async () => {
    const orgId = randomUUID();
    const userId = "board-user-failed-runs";
    const agentId = randomUUID();
    const olderRunId = randomUUID();
    const newerRunId = randomUUID();
    const olderActivityAt = new Date("2026-04-12T09:00:00.000Z");
    const newerActivityAt = new Date("2026-04-12T12:00:00.000Z");

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Failed Runs Org",
      urlKey: deriveOrganizationUrlKey("Messenger Failed Runs Org"),
      issuePrefix: `F${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Failure bot",
      role: "engineer",
      status: "active",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values([
      {
        id: olderRunId,
        orgId,
        agentId,
        invocationSource: "on_demand",
        status: "failed",
        error: "Older run failed",
        createdAt: olderActivityAt,
        updatedAt: olderActivityAt,
      },
      {
        id: newerRunId,
        orgId,
        agentId,
        invocationSource: "on_demand",
        status: "failed",
        error: "Newer run failed",
        createdAt: newerActivityAt,
        updatedAt: newerActivityAt,
      },
    ]);
    await messengerSvc.setThreadRead(orgId, userId, "failed-runs", new Date("2026-04-12T10:00:00.000Z"));

    const thread = await messengerSvc.getSystemThread(orgId, userId, "failed-runs");
    const summaries = await messengerSvc.listThreadSummaries(orgId, userId);
    const failedRunsSummary = summaries.find((item) => item.threadKey === "failed-runs");

    expect(thread.detail.items.map((item) => item.id)).toEqual([olderRunId, newerRunId]);
    expect(thread.summary.unreadCount).toBe(1);
    expect(thread.summary.latestActivityAt?.toISOString()).toBe(newerActivityAt.toISOString());
    expect(failedRunsSummary?.preview).toBe("Newer run failed");
    expect(failedRunsSummary?.unreadCount).toBe(1);
    expect(failedRunsSummary?.latestActivityAt?.toISOString()).toBe(newerActivityAt.toISOString());
  });

  it("summarizes pending join requests without loading the detail thread", async () => {
    const orgId = randomUUID();
    const otherOrgId = randomUUID();
    const userId = "board-user-join-requests";
    const olderRequestId = randomUUID();
    const newerRequestId = randomUUID();
    const resolvedRequestId = randomUUID();
    const otherOrgRequestId = randomUUID();
    const olderInviteId = randomUUID();
    const newerInviteId = randomUUID();
    const resolvedInviteId = randomUUID();
    const otherOrgInviteId = randomUUID();
    const activeChatId = randomUUID();
    const olderActivityAt = new Date("2026-04-12T09:00:00.000Z");
    const newerActivityAt = new Date("2026-04-12T12:00:00.000Z");

    await db.insert(organizations).values([
      {
        id: orgId,
        name: "Messenger Join Requests Org",
        urlKey: deriveOrganizationUrlKey("Messenger Join Requests Org"),
        issuePrefix: `J${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherOrgId,
        name: "Other Join Requests Org",
        urlKey: deriveOrganizationUrlKey("Other Join Requests Org"),
        issuePrefix: `O${otherOrgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    await db.insert(invites).values([
      {
        id: olderInviteId,
        orgId,
        tokenHash: `hash-${olderInviteId}`,
        expiresAt: new Date("2026-12-31T00:00:00.000Z"),
      },
      {
        id: newerInviteId,
        orgId,
        tokenHash: `hash-${newerInviteId}`,
        expiresAt: new Date("2026-12-31T00:00:00.000Z"),
      },
      {
        id: resolvedInviteId,
        orgId,
        tokenHash: `hash-${resolvedInviteId}`,
        expiresAt: new Date("2026-12-31T00:00:00.000Z"),
      },
      {
        id: otherOrgInviteId,
        orgId: otherOrgId,
        tokenHash: `hash-${otherOrgInviteId}`,
        expiresAt: new Date("2026-12-31T00:00:00.000Z"),
      },
    ]);
    await db.insert(joinRequests).values([
      {
        id: olderRequestId,
        inviteId: olderInviteId,
        orgId,
        requestType: "agent",
        status: "pending_approval",
        requestIp: "127.0.0.1",
        requestEmailSnapshot: "older@example.com",
        agentName: "Older request",
        capabilities: "Older request capabilities",
        createdAt: olderActivityAt,
        updatedAt: olderActivityAt,
      },
      {
        id: newerRequestId,
        inviteId: newerInviteId,
        orgId,
        requestType: "agent",
        status: "pending_approval",
        requestIp: "127.0.0.1",
        requestEmailSnapshot: "newer@example.com",
        agentName: "Newer request",
        capabilities: "Newer request capabilities",
        createdAt: newerActivityAt,
        updatedAt: newerActivityAt,
      },
      {
        id: resolvedRequestId,
        inviteId: resolvedInviteId,
        orgId,
        requestType: "agent",
        status: "approved",
        requestIp: "127.0.0.1",
        requestEmailSnapshot: "resolved@example.com",
        agentName: "Resolved request",
        capabilities: "Resolved request should not appear",
        createdAt: new Date("2026-04-12T13:00:00.000Z"),
        updatedAt: new Date("2026-04-12T13:00:00.000Z"),
      },
      {
        id: otherOrgRequestId,
        inviteId: otherOrgInviteId,
        orgId: otherOrgId,
        requestType: "agent",
        status: "pending_approval",
        requestIp: "127.0.0.1",
        requestEmailSnapshot: "other@example.com",
        agentName: "Other org request",
        capabilities: "Other org request should not appear",
        createdAt: new Date("2026-04-12T14:00:00.000Z"),
        updatedAt: new Date("2026-04-12T14:00:00.000Z"),
      },
    ]);
    await db.insert(chatConversations).values({
      id: activeChatId,
      orgId,
      title: "Older active chat",
      status: "active",
      lastMessageAt: olderActivityAt,
      createdAt: olderActivityAt,
      updatedAt: olderActivityAt,
    });
    await messengerSvc.setThreadRead(orgId, userId, "join-requests", new Date("2026-04-12T10:00:00.000Z"));

    const thread = await messengerSvc.getSystemThread(orgId, userId, "join-requests");
    const summaries = await messengerSvc.listThreadSummaries(orgId, userId);
    const joinRequestsSummary = summaries.find((item) => item.threadKey === "join-requests");

    expect(thread.detail.items.map((item) => item.id)).toEqual([newerRequestId, olderRequestId]);
    expect(thread.summary.unreadCount).toBe(1);
    expect(thread.summary.latestActivityAt?.toISOString()).toBe(newerActivityAt.toISOString());
    expect(joinRequestsSummary?.subtitle).toBe("2 items");
    expect(joinRequestsSummary?.preview).toBe("Newer request capabilities");
    expect(joinRequestsSummary?.unreadCount).toBe(1);
    expect(joinRequestsSummary?.latestActivityAt?.toISOString()).toBe(newerActivityAt.toISOString());
    expect(summaries[0]?.threadKey).toBe("join-requests");
    expect(thread.detail.items.map((item) => item.id)).not.toContain(resolvedRequestId);
    expect(thread.detail.items.map((item) => item.id)).not.toContain(otherOrgRequestId);
  });

  it("excludes archived chats from Messenger thread summaries", async () => {
    const orgId = randomUUID();
    const userId = "board-user-chat-archive";
    const activeChatId = randomUUID();
    const archivedChatId = randomUUID();
    const activeActivityAt = new Date("2026-04-12T12:00:00.000Z");
    const archivedActivityAt = new Date("2026-04-12T13:00:00.000Z");

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Archived Chats Org",
      urlKey: deriveOrganizationUrlKey("Messenger Archived Chats Org"),
      issuePrefix: `C${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(chatConversations).values([
      {
        id: activeChatId,
        orgId,
        title: "Active chat",
        status: "active",
        lastMessageAt: activeActivityAt,
        createdAt: activeActivityAt,
        updatedAt: activeActivityAt,
      },
      {
        id: archivedChatId,
        orgId,
        title: "Archived chat",
        status: "archived",
        lastMessageAt: archivedActivityAt,
        createdAt: archivedActivityAt,
        updatedAt: archivedActivityAt,
      },
    ]);

    const summaries = await messengerSvc.listThreadSummaries(orgId, userId);

    expect(summaries.map((item) => item.threadKey)).toContain(`chat:${activeChatId}`);
    expect(summaries.map((item) => item.threadKey)).not.toContain(`chat:${archivedChatId}`);
  });

  it("formats markdown headings in chat thread previews", async () => {
    const orgId = randomUUID();
    const userId = "board-user-chat-preview";
    const chatId = randomUUID();
    const activityAt = new Date("2026-04-12T12:00:00.000Z");

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Chat Preview Org",
      urlKey: deriveOrganizationUrlKey("Messenger Chat Preview Org"),
      issuePrefix: `P${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(chatConversations).values({
      id: chatId,
      orgId,
      title: "Chat preview",
      status: "active",
      lastMessageAt: activityAt,
      createdAt: activityAt,
      updatedAt: activityAt,
    });

    await db.insert(chatMessages).values({
      orgId,
      conversationId: chatId,
      role: "assistant",
      kind: "message",
      body: "## 需求\n把 Agent 的处理流程规范化",
      createdAt: activityAt,
      updatedAt: activityAt,
    });

    const summaries = await messengerSvc.listThreadSummaries(orgId, userId);
    const chatSummary = summaries.find((item) => item.threadKey === `chat:${chatId}`);

    expect(chatSummary?.preview).toBe("需求: 把 Agent 的处理流程规范化");
    expect(chatSummary?.subtitle).toBe("需求: 把 Agent 的处理流程规范化");
  });

  it("hides empty synthetic threads for a brand-new organization", async () => {
    const orgId = randomUUID();
    const userId = "board-user-empty";

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Empty Org",
      urlKey: deriveOrganizationUrlKey("Messenger Empty Org"),
      issuePrefix: `E${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const summaries = await messengerSvc.listThreadSummaries(orgId, userId);

    expect(summaries).toEqual([]);
  });

  it("includes chat pinned state in Messenger thread summaries", async () => {
    const orgId = randomUUID();
    const userId = "board-user-pinned-summary";

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Pinned Summary Org",
      urlKey: deriveOrganizationUrlKey("Messenger Pinned Summary Org"),
      issuePrefix: `P${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const pinnedConversation = await chatSvc.create(orgId, {
      title: "Pinned from summary",
      summary: "Pinned status should travel with /messenger/threads.",
      issueCreationMode: "manual_approval",
      planMode: false,
      createdByUserId: userId,
    });
    const unpinnedConversation = await chatSvc.create(orgId, {
      title: "Unpinned from summary",
      summary: "This one should remain recent only.",
      issueCreationMode: "manual_approval",
      planMode: false,
      createdByUserId: userId,
    });
    await chatSvc.setPinned(pinnedConversation.id, orgId, userId, true);

    const summaries = await messengerSvc.listThreadSummaries(orgId, userId);

    expect(summaries.find((item) => item.threadKey === `chat:${pinnedConversation.id}`)?.isPinned).toBe(true);
    expect(summaries.find((item) => item.threadKey === `chat:${unpinnedConversation.id}`)?.isPinned).toBe(false);
  });

  it("persists Messenger synthetic thread read state", async () => {
    const orgId = randomUUID();
    const userId = "board-user-2";
    const readAt = new Date("2026-04-10T10:00:00.000Z");

    await db.insert(organizations).values({
      id: orgId,
      name: "Messenger Org Read State",
      urlKey: deriveOrganizationUrlKey("Messenger Org Read State"),
      issuePrefix: `R${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const state = await messengerSvc.setThreadRead(orgId, userId, "issues", readAt);
    expect(state?.lastReadAt.toISOString()).toBe(readAt.toISOString());

    const persisted = await messengerSvc.getThreadState(orgId, userId, "issues");
    expect(persisted?.lastReadAt.toISOString()).toBe(readAt.toISOString());
  });
});
