import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { eq, sql } from "../../packages/db/node_modules/drizzle-orm/index.js";
import {
  agents,
  approvalComments,
  approvals,
  applyPendingMigrations,
  chatConversationUserStates,
  chatConversations,
  chatMessages,
  costEvents,
  createDb,
  heartbeatRuns,
  invites,
  issueComments,
  issueReadStates,
  issues,
  joinRequests,
  messengerThreadUserStates,
  organizations,
} from "../../packages/db/src/index.js";
import { sidebarBadgeService } from "../../server/src/services/sidebar-badges.js";
import { messengerService } from "../../server/src/services/messenger.js";
import { costService } from "../../server/src/services/costs.js";
import { visibleIncomingMessageSql } from "../../server/src/services/chats.helpers.js";

type ScaleName = "smoke" | "medium";

type ScenarioScale = {
  agents: number;
  issues: number;
  issueCommentsPerIssue: number;
  chats: number;
  chatMessagesPerChat: number;
  approvals: number;
  approvalCommentsPerApproval: number;
  failedRuns: number;
  joinRequests: number;
  costEvents: number;
};

const SCALES: Record<ScaleName, ScenarioScale> = {
  smoke: {
    agents: 12,
    issues: 120,
    issueCommentsPerIssue: 2,
    chats: 40,
    chatMessagesPerChat: 2,
    approvals: 40,
    approvalCommentsPerApproval: 1,
    failedRuns: 30,
    joinRequests: 10,
    costEvents: 80,
  },
  medium: {
    agents: 40,
    issues: 1_500,
    issueCommentsPerIssue: 3,
    chats: 400,
    chatMessagesPerChat: 3,
    approvals: 300,
    approvalCommentsPerApproval: 2,
    failedRuns: 500,
    joinRequests: 100,
    costEvents: 1_500,
  },
};

function parseArgs(argv: string[]) {
  let scale: ScaleName = "smoke";
  let keepData = false;
  let migrate = true;
  let explain = false;
  let iterations = 5;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--scale") {
      const value = argv[index + 1] as ScaleName | undefined;
      if (!value || !(value in SCALES)) {
        throw new Error(`Unsupported --scale "${value ?? ""}". Use ${Object.keys(SCALES).join(" or ")}.`);
      }
      scale = value;
      index += 1;
      continue;
    }
    if (arg === "--iterations") {
      const value = Number(argv[index + 1]);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error("--iterations must be a positive integer.");
      }
      iterations = value;
      index += 1;
      continue;
    }
    if (arg === "--keep-data") {
      keepData = true;
      continue;
    }
    if (arg === "--no-migrate") {
      migrate = false;
      continue;
    }
    if (arg === "--explain") {
      explain = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { scale, keepData, migrate, explain, iterations };
}

function minutesAgo(minutes: number) {
  return new Date(Date.now() - minutes * 60_000);
}

async function insertChunks<T>(rows: T[], insert: (chunk: T[]) => Promise<unknown>, chunkSize = 500) {
  for (let index = 0; index < rows.length; index += chunkSize) {
    await insert(rows.slice(index, index + chunkSize));
  }
}

async function timed<T>(name: string, fn: () => Promise<T>) {
  const start = performance.now();
  const result = await fn();
  const ms = performance.now() - start;
  return { name, ms: Number(ms.toFixed(2)), result };
}

function summarize(samples: Array<{ name: string; ms: number }>) {
  const byName = new Map<string, number[]>();
  for (const sample of samples) {
    const existing = byName.get(sample.name) ?? [];
    existing.push(sample.ms);
    byName.set(sample.name, existing);
  }
  return Array.from(byName.entries()).map(([name, values]) => {
    const sorted = [...values].sort((a, b) => a - b);
    const sum = values.reduce((acc, value) => acc + value, 0);
    return {
      name,
      runs: values.length,
      minMs: sorted[0],
      p50Ms: sorted[Math.floor((sorted.length - 1) / 2)],
      maxMs: sorted[sorted.length - 1],
      avgMs: Number((sum / values.length).toFixed(2)),
    };
  });
}

function currentUtcMonthWindow(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return {
    start: new Date(Date.UTC(year, month, 1, 0, 0, 0, 0)),
    end: new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0)),
  };
}

async function explainQuery(db: ReturnType<typeof createDb>, name: string, query: ReturnType<typeof sql>) {
  const rows = await db.execute(sql<Record<string, string>>`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${query}`);
  return {
    name,
    plan: rows.map((row) => row["QUERY PLAN"] ?? Object.values(row)[0] ?? ""),
  };
}

async function explainOptimizedPaths(
  db: ReturnType<typeof createDb>,
  orgId: string,
  boardUserId: string,
  agentId: string,
) {
  const { start, end } = currentUtcMonthWindow();
  const queries = [
    {
      name: "sidebar.actionableApprovals",
      query: sql`select count(*)::int from approvals where org_id = ${orgId} and status = 'pending'`,
    },
    {
      name: "sidebar.latestFailedRuns",
      query: sql`
        select count(*)::int
        from (
          select
            heartbeat_runs.status as run_status,
            row_number() over (
              partition by heartbeat_runs.agent_id
              order by heartbeat_runs.created_at desc
            ) as run_rank
          from heartbeat_runs
          inner join agents
            on heartbeat_runs.agent_id = agents.id
            and agents.org_id = ${orgId}
          where heartbeat_runs.org_id = ${orgId}
            and agents.status <> 'terminated'
        ) latest_agent_runs
        where latest_agent_runs.run_rank = 1
          and latest_agent_runs.run_status in ('failed', 'timed_out')
      `,
    },
    {
      name: "messenger.failedRunsLatest",
      query: sql`
        select error, stderr_excerpt
        from heartbeat_runs
        where org_id = ${orgId}
          and status = 'failed'
        order by updated_at desc, created_at desc
        limit 1
      `,
    },
    {
      name: "messenger.joinRequestsLatest",
      query: sql`
        select capabilities, request_email_snapshot
        from join_requests
        where org_id = ${orgId}
          and status = 'pending_approval'
        order by updated_at desc, created_at desc
        limit 1
      `,
    },
    {
      name: "messenger.approvalsLatest",
      query: sql`
        select *
        from approvals
        where org_id = ${orgId}
        order by updated_at desc, created_at desc
        limit 1
      `,
    },
    {
      name: "messenger.approvalCommentsLatest",
      query: sql`
        select latest_comment.approval_id, latest_comment.body, latest_comment.created_at
        from approvals
        inner join lateral (
          select approval_comments.approval_id, approval_comments.body, approval_comments.created_at
          from approval_comments
          where approval_comments.org_id = ${orgId}
            and approval_comments.approval_id = approvals.id
          order by approval_comments.created_at desc
          limit 1
        ) latest_comment on true
        where approvals.org_id = ${orgId}
        order by latest_comment.created_at desc
        limit 1
      `,
    },
    {
      name: "costs.monthlySpendTotalsForEvent",
      query: sql`
        select
          coalesce(sum(case when agent_id = ${agentId} then cost_cents else 0 end), 0)::double precision as agent_total,
          coalesce(sum(cost_cents), 0)::double precision as organization_total
        from cost_events
        where org_id = ${orgId}
          and occurred_at >= ${start.toISOString()}::timestamptz
          and occurred_at < ${end.toISOString()}::timestamptz
      `,
    },
    {
      name: "sidebar.activeChatAttention",
      query: sql`
        select count(*)::int
        from chat_conversations
        where chat_conversations.org_id = ${orgId}
          and chat_conversations.status = 'active'
          and (
            exists (
              select 1
              from chat_messages
              inner join chat_conversation_user_states
                on chat_conversation_user_states.org_id = ${orgId}
                and chat_conversation_user_states.user_id = ${boardUserId}
                and chat_conversation_user_states.conversation_id = chat_messages.conversation_id
              where chat_messages.org_id = ${orgId}
                and chat_messages.conversation_id = chat_conversations.id
                and chat_messages.superseded_at is null
                and ${visibleIncomingMessageSql()}
                and chat_messages.created_at > chat_conversation_user_states.last_read_at
            )
            or exists (
              select 1
              from chat_messages
              inner join approvals on chat_messages.approval_id = approvals.id
              where chat_messages.org_id = ${orgId}
                and chat_messages.conversation_id = chat_conversations.id
                and chat_messages.superseded_at is null
                and approvals.org_id = ${orgId}
                and approvals.status = 'pending'
            )
          )
      `,
    },
  ];
  const plans: Array<Awaited<ReturnType<typeof explainQuery>>> = [];
  for (const query of queries) {
    plans.push(await explainQuery(db, query.name, query.query));
  }
  return plans;
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required. Use an isolated database for repeatable perf runs.");
  }

  const options = parseArgs(process.argv.slice(2));
  if (options.migrate) {
    await applyPendingMigrations(databaseUrl);
  }

  const db = createDb(databaseUrl);
  const scale = SCALES[options.scale];
  const orgId = randomUUID();
  const boardUserId = `perf-board-${orgId.slice(0, 8)}`;
  const agentIds = Array.from({ length: scale.agents }, () => randomUUID());
  const issueIds = Array.from({ length: scale.issues }, () => randomUUID());
  const chatIds = Array.from({ length: scale.chats }, () => randomUUID());
  const approvalIds = Array.from({ length: scale.approvals }, () => randomUUID());
  const inviteIds = Array.from({ length: scale.joinRequests }, () => randomUUID());

  try {
    await db.insert(organizations).values({
      id: orgId,
      name: `Control Plane Perf ${orgId.slice(0, 8)}`,
      urlKey: `control-plane-perf-${orgId.slice(0, 8)}`,
      issuePrefix: `P${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      budgetMonthlyCents: 500_000,
      requireBoardApprovalForNewAgents: false,
    });

    await insertChunks(agentIds.map((id, index) => ({
      id,
      orgId,
      name: `Perf Agent ${index + 1}`,
      role: "engineer",
      status: index % 13 === 0 ? "error" : "active",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    })), (chunk) => db.insert(agents).values(chunk));

    await insertChunks(issueIds.map((id, index) => ({
      id,
      orgId,
      title: `Perf issue ${index + 1}`,
      description: "Seeded issue for control-plane perf timing.",
      status: ["todo", "in_progress", "in_review", "blocked", "done"][index % 5],
      priority: ["low", "medium", "high"][index % 3],
      assigneeUserId: index % 2 === 0 ? boardUserId : null,
      reviewerUserId: index % 7 === 0 ? boardUserId : null,
      createdByUserId: index % 5 === 0 ? boardUserId : null,
      assigneeAgentId: agentIds[index % agentIds.length],
      updatedAt: minutesAgo(scale.issues - index),
      createdAt: minutesAgo(scale.issues + index),
    })), (chunk) => db.insert(issues).values(chunk));

    const issueCommentRows = issueIds.flatMap((issueId, issueIndex) =>
      Array.from({ length: scale.issueCommentsPerIssue }, (_, commentIndex) => ({
        orgId,
        issueId,
        authorAgentId: agentIds[(issueIndex + commentIndex) % agentIds.length],
        authorUserId: null,
        body: `External issue comment ${commentIndex + 1} for issue ${issueIndex + 1}.`,
        createdAt: minutesAgo(issueIndex + commentIndex),
      })));
    await insertChunks(issueCommentRows, (chunk) => db.insert(issueComments).values(chunk));

    await insertChunks(issueIds.filter((_, index) => index % 4 === 0).map((issueId, index) => ({
      orgId,
      issueId,
      userId: boardUserId,
      lastReadAt: minutesAgo(scale.issues + index + 10),
    })), (chunk) => db.insert(issueReadStates).values(chunk));

    await insertChunks(chatIds.map((id, index) => ({
      id,
      orgId,
      title: `Perf chat ${index + 1}`,
      summary: `Summary for perf chat ${index + 1}`,
      status: "active",
      createdByUserId: boardUserId,
      lastMessageAt: minutesAgo(scale.chats - index),
      updatedAt: minutesAgo(scale.chats - index),
    })), (chunk) => db.insert(chatConversations).values(chunk));

    await insertChunks(chatIds.map((conversationId, index) => ({
      orgId,
      conversationId,
      userId: boardUserId,
      lastReadAt: minutesAgo(scale.chats + index + 10),
    })), (chunk) => db.insert(chatConversationUserStates).values(chunk));

    const chatMessageRows = chatIds.flatMap((conversationId, chatIndex) =>
      Array.from({ length: scale.chatMessagesPerChat }, (_, messageIndex) => ({
        orgId,
        conversationId,
        role: messageIndex % 2 === 0 ? "assistant" : "user",
        kind: "message",
        status: "completed",
        body: `Perf chat message ${messageIndex + 1} in chat ${chatIndex + 1}.`,
        createdAt: minutesAgo(chatIndex + messageIndex),
      })));
    await insertChunks(chatMessageRows, (chunk) => db.insert(chatMessages).values(chunk));

    await insertChunks(approvalIds.map((id, index) => ({
      id,
      orgId,
      type: index % 2 === 0 ? "chat_issue_creation" : "hire_agent",
      status: index % 3 === 0 ? "pending" : "approved",
      requestedByUserId: boardUserId,
      payload: { name: `Approval ${index + 1}`, proposedIssue: { title: `Approval issue ${index + 1}` } },
      updatedAt: minutesAgo(scale.approvals - index),
      createdAt: minutesAgo(scale.approvals + index),
    })), (chunk) => db.insert(approvals).values(chunk));

    const approvalCommentRows = approvalIds.flatMap((approvalId, approvalIndex) =>
      Array.from({ length: scale.approvalCommentsPerApproval }, (_, commentIndex) => ({
        orgId,
        approvalId,
        authorUserId: boardUserId,
        body: `Approval comment ${commentIndex + 1} for approval ${approvalIndex + 1}.`,
        createdAt: minutesAgo(approvalIndex + commentIndex),
      })));
    await insertChunks(approvalCommentRows, (chunk) => db.insert(approvalComments).values(chunk));

    await insertChunks(Array.from({ length: scale.failedRuns }, (_, index) => ({
      orgId,
      agentId: agentIds[index % agentIds.length],
      invocationSource: "on_demand",
      status: index % 2 === 0 ? "failed" : "succeeded",
      error: index % 2 === 0 ? `Perf failure ${index + 1}` : null,
      createdAt: minutesAgo(scale.failedRuns - index),
      updatedAt: minutesAgo(scale.failedRuns - index),
    })), (chunk) => db.insert(heartbeatRuns).values(chunk));

    await insertChunks(inviteIds.map((id, index) => ({
      id,
      orgId,
      tokenHash: `perf-token-${id}`,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000),
      createdAt: minutesAgo(index),
    })), (chunk) => db.insert(invites).values(chunk));
    await insertChunks(inviteIds.map((inviteId, index) => ({
      inviteId,
      orgId,
      requestType: "agent",
      status: "pending_approval",
      requestIp: "127.0.0.1",
      agentName: `Joining Agent ${index + 1}`,
      capabilities: "Perf seeded join request.",
      createdAt: minutesAgo(index),
      updatedAt: minutesAgo(index),
    })), (chunk) => db.insert(joinRequests).values(chunk));

    await insertChunks(Array.from({ length: scale.costEvents }, (_, index) => ({
      orgId,
      agentId: agentIds[index % agentIds.length],
      provider: "openai",
      biller: "openai",
      billingType: "metered_api",
      model: "gpt-5",
      inputTokens: 1_000 + index,
      cachedInputTokens: 500,
      outputTokens: 200,
      costCents: 3,
      occurredAt: minutesAgo(index),
    })), (chunk) => db.insert(costEvents).values(chunk));

    const sidebar = sidebarBadgeService(db);
    const messenger = messengerService(db);
    const costs = costService(db);
    const samples: Array<{ name: string; ms: number }> = [];

    for (let index = 0; index < options.iterations; index += 1) {
      samples.push(await timed("sidebar.getBaseCounts", () => sidebar.getBaseCounts(orgId)));
      samples.push(await timed("sidebar.countUnreadTouchedIssues", () => sidebar.countUnreadTouchedIssues(orgId, boardUserId)));
      samples.push(await timed("sidebar.countActiveChatAttention", () => sidebar.countActiveChatAttention(orgId, boardUserId)));
      samples.push(await timed("messenger.listThreadSummaries", () => messenger.listThreadSummaries(orgId, boardUserId)));
      samples.push(await timed("costs.createEvent", () => costs.createEvent(orgId, {
        agentId: agentIds[index % agentIds.length],
        provider: "openai",
        model: "gpt-5",
        inputTokens: 1_000,
        cachedInputTokens: 500,
        outputTokens: 200,
        costCents: 3,
        occurredAt: new Date(),
      })));
    }
    const explainPlans = options.explain
      ? await explainOptimizedPaths(db, orgId, boardUserId, agentIds[0]!)
      : undefined;

    console.log(JSON.stringify({
      orgId,
      scale: options.scale,
      rows: {
        agents: scale.agents,
        issues: scale.issues,
        issueComments: issueCommentRows.length,
        chats: scale.chats,
        chatMessages: chatMessageRows.length,
        approvals: scale.approvals,
        approvalComments: approvalCommentRows.length,
        failedRuns: scale.failedRuns,
        joinRequests: scale.joinRequests,
        costEvents: scale.costEvents + options.iterations,
      },
      iterations: options.iterations,
      timings: summarize(samples),
      ...(explainPlans ? { explainPlans } : {}),
    }, null, 2));
  } finally {
    if (!options.keepData) {
      await db.delete(costEvents).where(eq(costEvents.orgId, orgId));
      await db.delete(messengerThreadUserStates).where(eq(messengerThreadUserStates.orgId, orgId));
      await db.delete(chatConversationUserStates).where(eq(chatConversationUserStates.orgId, orgId));
      await db.delete(chatMessages).where(eq(chatMessages.orgId, orgId));
      await db.delete(chatConversations).where(eq(chatConversations.orgId, orgId));
      await db.delete(approvalComments).where(eq(approvalComments.orgId, orgId));
      await db.delete(approvals).where(eq(approvals.orgId, orgId));
      await db.delete(joinRequests).where(eq(joinRequests.orgId, orgId));
      await db.delete(invites).where(eq(invites.orgId, orgId));
      await db.delete(heartbeatRuns).where(eq(heartbeatRuns.orgId, orgId));
      await db.delete(issueReadStates).where(eq(issueReadStates.orgId, orgId));
      await db.delete(issueComments).where(eq(issueComments.orgId, orgId));
      await db.delete(issues).where(eq(issues.orgId, orgId));
      await db.delete(agents).where(eq(agents.orgId, orgId));
      await db.delete(organizations).where(eq(organizations.id, orgId));
    }
    await (db as unknown as { $client?: { end?: (options?: { timeout?: number }) => Promise<void> } })
      .$client?.end?.({ timeout: 1 });
  }
}

await main();
