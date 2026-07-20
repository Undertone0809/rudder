import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { inArray, sql } from "../../packages/db/node_modules/drizzle-orm/index.js";
import {
  activityLog,
  agents,
  applyPendingMigrations,
  approvalComments,
  approvals,
  chatConversations,
  chatConversationUserStates,
  chatMessages,
  costEvents,
  costMonthlySpendRollups,
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
import { activityService } from "../../server/src/services/activity.js";
import { visibleIncomingMessageSql } from "../../server/src/services/chats.helpers.js";
import { chatService } from "../../server/src/services/chats.js";
import { costService } from "../../server/src/services/costs.js";
import { issueService } from "../../server/src/services/issues.js";
import { messengerService } from "../../server/src/services/messenger.js";
import { sidebarBadgeService } from "../../server/src/services/sidebar-badges.js";
import {
  evaluateSequenceGates,
  getScenarioScale,
  isScaleName,
  scaleNames,
  summarizeTimingSamples,
  THREAD_PRESSURE_RECIPE,
  WORKLOAD_MANIFEST_VERSION,
  workloadManifestHash,
  type ScaleName,
  type TimingSample,
} from "./workflow-baseline.helpers.js";

function parseArgs(argv: string[]) {
  let scale: ScaleName = "smoke";
  let keepData = false;
  let migrate = true;
  let explain = false;
  let iterations = 5;
  let warmups = 2;
  let anchor = new Date("2026-07-20T00:00:00.000Z");

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--scale") {
      const value = argv[index + 1];
      if (!value || !isScaleName(value)) {
        throw new Error(`Unsupported --scale "${value ?? ""}". Use ${scaleNames().join(" or ")}.`);
      }
      scale = value;
      index += 1;
      continue;
    }
    if (arg === "--warmups") {
      const value = Number(argv[index + 1]);
      if (!Number.isInteger(value) || value < 0) {
        throw new Error("--warmups must be a non-negative integer.");
      }
      warmups = value;
      index += 1;
      continue;
    }
    if (arg === "--anchor") {
      const value = new Date(argv[index + 1] ?? "");
      if (!Number.isFinite(value.getTime())) {
        throw new Error("--anchor must be an ISO-8601 timestamp.");
      }
      anchor = value;
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

  return { scale, keepData, migrate, explain, iterations, warmups, anchor };
}

function minutesAgo(minutes: number, anchor: Date) {
  return new Date(anchor.getTime() - minutes * 60_000);
}

async function insertChunks<T>(rows: T[], insert: (chunk: T[]) => Promise<unknown>, chunkSize = 500) {
  for (let index = 0; index < rows.length; index += chunkSize) {
    await insert(rows.slice(index, index + chunkSize));
  }
}

async function insertGeneratedChunks<T>(
  count: number,
  createRow: (index: number) => T,
  insert: (chunk: T[]) => Promise<unknown>,
  chunkSize = 500,
) {
  for (let start = 0; start < count; start += chunkSize) {
    const size = Math.min(chunkSize, count - start);
    const rows = Array.from({ length: size }, (_, offset) => createRow(start + offset));
    await insert(rows);
  }
}

async function timed<T>(name: string, fn: () => Promise<T>) {
  const start = performance.now();
  const result = await fn();
  const ms = performance.now() - start;
  return { name, ms: Number(ms.toFixed(2)), result };
}

function pressureTimestamp(anchor: Date, index: number) {
  return new Date(anchor.getTime() + Math.floor(index / THREAD_PRESSURE_RECIPE.timestampTieWidth) * 1_000);
}

function pressureBody(entity: "chat" | "comment", index: number) {
  const prefix = `${entity} pressure row ${index + 1}`;
  switch (index % THREAD_PRESSURE_RECIPE.payloadVariantCount) {
    case 0:
      return `${prefix}: short payload.`;
    case 1:
      return `${prefix}: ${"medium payload with repeated context. ".repeat(12)}`;
    case 2:
      return `${prefix}\n\n## Markdown evidence\n\n- organization scoped\n- 中文与 emoji 🧭\n\n\`\`\`json\n{"index":${index},"kind":"${entity}"}\n\`\`\``;
    default:
      return `${prefix}: ${"transcript-like stdout and structured evidence. ".repeat(80)}`;
  }
}

function serializedBytes(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function memorySnapshot() {
  const usage = process.memoryUsage();
  return { heapUsed: usage.heapUsed, rss: usage.rss };
}

function memoryDelta(before: ReturnType<typeof memorySnapshot>, after: ReturnType<typeof memorySnapshot>) {
  return {
    heapUsedBytes: after.heapUsed - before.heapUsed,
    rssBytes: after.rss - before.rss,
  };
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
  hotChatId: string | null,
  hotIssueId: string | null,
) {
  const { start } = currentUtcMonthWindow();
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
      name: "sidebar.unreadTouchedIssues",
      query: sql`
        with comment_stats as (
          select
            issue_comments.issue_id as issue_id,
            max(issue_comments.created_at) filter (
              where issue_comments.author_user_id = ${boardUserId}
            ) as my_last_comment_at,
            max(issue_comments.created_at) filter (
              where issue_comments.author_user_id is null
                or issue_comments.author_user_id <> ${boardUserId}
            ) as last_external_comment_at
          from issue_comments
          where issue_comments.org_id = ${orgId}
          group by issue_comments.issue_id
        ),
        read_stats as (
          select
            issue_read_states.issue_id as issue_id,
            max(issue_read_states.last_read_at) as my_last_read_at
          from issue_read_states
          where issue_read_states.org_id = ${orgId}
            and issue_read_states.user_id = ${boardUserId}
          group by issue_read_states.issue_id
        )
        select count(*)::int as count
        from issues
        left join comment_stats on comment_stats.issue_id = issues.id
        left join read_stats on read_stats.issue_id = issues.id
        where issues.org_id = ${orgId}
          and issues.status in ('backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done')
          and issues.origin_kind <> 'automation_execution'
          and issues.hidden_at is null
          and (
            issues.created_by_user_id = ${boardUserId}
            or issues.assignee_user_id = ${boardUserId}
            or issues.reviewer_user_id = ${boardUserId}
            or read_stats.my_last_read_at is not null
            or comment_stats.my_last_comment_at is not null
          )
          and comment_stats.last_external_comment_at > greatest(
            coalesce(comment_stats.my_last_comment_at, to_timestamp(0)),
            coalesce(read_stats.my_last_read_at, to_timestamp(0)),
            coalesce(case when issues.created_by_user_id = ${boardUserId} then issues.created_at else null end, to_timestamp(0)),
            coalesce(case when issues.assignee_user_id = ${boardUserId} then issues.updated_at else null end, to_timestamp(0)),
            coalesce(case when issues.reviewer_user_id = ${boardUserId} then issues.updated_at else null end, to_timestamp(0))
          )
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
      name: "costs.monthlySpendRollupLookup",
      query: sql`
        select scope_type, scope_id, spend_cents
        from cost_monthly_spend_rollups
        where org_id = ${orgId}
          and month_start = ${start.toISOString()}::timestamptz
          and (
            (scope_type = 'organization' and scope_id = ${orgId})
            or (scope_type = 'agent' and scope_id = ${agentId})
          )
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
  if (hotChatId) {
    queries.push({
      name: "chat.listMessages.hot",
      query: sql`
        select
          chat_messages.id,
          case
            when jsonb_typeof(chat_messages.structured_payload->'__chatTranscript') = 'array'
              and jsonb_array_length(chat_messages.structured_payload->'__chatTranscript') > 0
            then jsonb_build_object(
              'entryCount', jsonb_array_length(chat_messages.structured_payload->'__chatTranscript'),
              'startedAt', (
                select min(entry.value->>'ts')
                from jsonb_array_elements(chat_messages.structured_payload->'__chatTranscript') as entry(value)
                where entry.value ? 'ts'
              ),
              'endedAt', (
                select max(entry.value->>'ts')
                from jsonb_array_elements(chat_messages.structured_payload->'__chatTranscript') as entry(value)
                where entry.value ? 'ts'
              )
            )
            else null
          end as transcript_summary
        from chat_messages
        where chat_messages.conversation_id = ${hotChatId}
          and chat_messages.org_id in (
            select chat_conversations.org_id
            from chat_conversations
            where chat_conversations.id = ${hotChatId}
          )
        order by chat_messages.created_at, chat_messages.id
      `,
    });
  }
  if (hotIssueId) {
    queries.push(
      {
        name: "issue.listComments.hot",
        query: sql`
          select issue_comments.id
          from issue_comments
          where issue_comments.issue_id = ${hotIssueId}
            and issue_comments.deleted_at is null
            and issue_comments.org_id in (
              select issues.org_id from issues where issues.id = ${hotIssueId}
            )
          order by issue_comments.created_at, issue_comments.id
        `,
      },
      {
        name: "activity.runsForIssue.hot",
        query: sql`
          select heartbeat_runs.id
          from heartbeat_runs
          where heartbeat_runs.org_id = ${orgId}
            and (
              heartbeat_runs.context_snapshot ->> 'issueId' = ${hotIssueId}
              or exists (
                select 1
                from activity_log
                where activity_log.org_id = ${orgId}
                  and activity_log.entity_type = 'issue'
                  and activity_log.entity_id = ${hotIssueId}
                  and activity_log.run_id = heartbeat_runs.id
              )
            )
          order by heartbeat_runs.created_at desc, heartbeat_runs.id desc
        `,
      },
    );
  }
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
  const scale = getScenarioScale(options.scale);
  const atMinutesAgo = (minutes: number) => minutesAgo(minutes, options.anchor);
  const orgId = randomUUID();
  const neighborOrgId = scale.neighborOrgSentinels > 0 ? randomUUID() : null;
  const boardUserId = `perf-board-${orgId.slice(0, 8)}`;
  const agentIds = Array.from({ length: scale.agents }, () => randomUUID());
  const issueIds = Array.from({ length: scale.issues }, () => randomUUID());
  const chatIds = Array.from({ length: scale.chats }, () => randomUUID());
  const approvalIds = Array.from({ length: scale.approvals }, () => randomUUID());
  const inviteIds = Array.from({ length: scale.joinRequests }, () => randomUUID());
  const hotIssueId = scale.hotIssueComments > 0 || scale.hotIssueRuns > 0 ? issueIds[0]! : null;
  const hotChatId = scale.hotChatMessages > 0 ? chatIds[0]! : null;
  const neighborAgentId = neighborOrgId ? randomUUID() : null;
  const neighborIssueId = neighborOrgId ? randomUUID() : null;
  const neighborChatId = neighborOrgId ? randomUUID() : null;
  const hotChatMessageIds: string[] = [];
  const hotIssueCommentIds: string[] = [];
  const hotIssueRunIds: string[] = [];
  const activityOnlyHotIssueRunIds: string[] = [];

  try {
    await db.insert(organizations).values({
      id: orgId,
      name: `Workflow Perf ${orgId.slice(0, 8)}`,
      urlKey: `workflow-perf-${orgId.slice(0, 8)}`,
      issuePrefix: `P${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      budgetMonthlyCents: 500_000,
      requireBoardApprovalForNewAgents: false,
    });
    if (neighborOrgId) {
      await db.insert(organizations).values({
        id: neighborOrgId,
        name: `Workflow Neighbor ${neighborOrgId.slice(0, 8)}`,
        urlKey: `workflow-neighbor-${neighborOrgId.slice(0, 8)}`,
        issuePrefix: `N${neighborOrgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        budgetMonthlyCents: 500_000,
        requireBoardApprovalForNewAgents: false,
      });
    }

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
    if (neighborOrgId && neighborAgentId) {
      await db.insert(agents).values({
        id: neighborAgentId,
        orgId: neighborOrgId,
        name: "Neighbor Pressure Agent",
        role: "engineer",
        status: "active",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
    }

    await insertChunks(issueIds.map((id, index) => ({
      id,
      orgId,
      title: `Perf issue ${index + 1}`,
      description: "Seeded issue for workflow performance timing.",
      status: ["todo", "in_progress", "in_review", "blocked", "done"][index % 5],
      priority: ["low", "medium", "high"][index % 3],
      assigneeUserId: index % 2 === 0 ? boardUserId : null,
      reviewerUserId: index % 7 === 0 ? boardUserId : null,
      createdByUserId: index % 5 === 0 ? boardUserId : null,
      assigneeAgentId: agentIds[index % agentIds.length],
      updatedAt: atMinutesAgo(scale.issues - index),
      createdAt: atMinutesAgo(scale.issues + index),
    })), (chunk) => db.insert(issues).values(chunk));
    if (neighborOrgId && neighborIssueId && neighborAgentId) {
      await db.insert(issues).values({
        id: neighborIssueId,
        orgId: neighborOrgId,
        title: "Neighbor issue with colliding pressure content",
        description: "Must not appear in the primary organization benchmark.",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: neighborAgentId,
        createdAt: options.anchor,
        updatedAt: options.anchor,
      });
    }

    const issueCommentRows = issueIds.flatMap((issueId, issueIndex) =>
      Array.from({ length: issueId === hotIssueId ? 0 : scale.issueCommentsPerIssue }, (_, commentIndex) => ({
        orgId,
        issueId,
        authorAgentId: agentIds[(issueIndex + commentIndex) % agentIds.length],
        authorUserId: null,
        body: `External issue comment ${commentIndex + 1} for issue ${issueIndex + 1}.`,
        createdAt: atMinutesAgo(issueIndex + commentIndex),
      })));
    await insertChunks(issueCommentRows, (chunk) => db.insert(issueComments).values(chunk));
    if (hotIssueId) {
      await insertGeneratedChunks(
        scale.hotIssueComments,
        (index) => {
          const id = randomUUID();
          hotIssueCommentIds.push(id);
          return {
            id,
            orgId,
            issueId: hotIssueId,
            authorAgentId: index % 5 === 0 ? null : agentIds[index % agentIds.length],
            authorUserId: index % 5 === 0 ? boardUserId : null,
            body: pressureBody("comment", index),
            createdAt: pressureTimestamp(options.anchor, index),
            updatedAt: pressureTimestamp(options.anchor, index),
          };
        },
        (chunk) => db.insert(issueComments).values(chunk),
      );
    }
    if (neighborOrgId && neighborIssueId && neighborAgentId) {
      await insertGeneratedChunks(
        scale.neighborOrgSentinels,
        (index) => ({
          orgId: neighborOrgId,
          issueId: neighborIssueId,
          authorAgentId: neighborAgentId,
          body: pressureBody("comment", index),
          createdAt: pressureTimestamp(options.anchor, index),
          updatedAt: pressureTimestamp(options.anchor, index),
        }),
        (chunk) => db.insert(issueComments).values(chunk),
      );
    }
    if (neighborOrgId && neighborAgentId && hotIssueId) {
      await insertGeneratedChunks(
        scale.neighborOrgSentinels,
        (index) => ({
          orgId: neighborOrgId,
          issueId: hotIssueId,
          authorAgentId: neighborAgentId,
          body: `Cross-organization issue sentinel ${index + 1}.`,
          createdAt: pressureTimestamp(options.anchor, index),
          updatedAt: pressureTimestamp(options.anchor, index),
        }),
        (chunk) => db.insert(issueComments).values(chunk),
      );
    }

    await insertChunks(issueIds.filter((_, index) => index % 4 === 0).map((issueId, index) => ({
      orgId,
      issueId,
      userId: boardUserId,
      lastReadAt: atMinutesAgo(scale.issues + index + 10),
    })), (chunk) => db.insert(issueReadStates).values(chunk));

    await insertChunks(chatIds.map((id, index) => ({
      id,
      orgId,
      title: `Perf chat ${index + 1}`,
      summary: `Summary for perf chat ${index + 1}`,
      status: "active",
      createdByUserId: boardUserId,
      lastMessageAt: atMinutesAgo(scale.chats - index),
      updatedAt: atMinutesAgo(scale.chats - index),
    })), (chunk) => db.insert(chatConversations).values(chunk));
    if (neighborOrgId && neighborChatId) {
      await db.insert(chatConversations).values({
        id: neighborChatId,
        orgId: neighborOrgId,
        title: "Neighbor pressure chat",
        summary: "Must not appear in the primary organization benchmark.",
        status: "active",
        lastMessageAt: options.anchor,
        updatedAt: options.anchor,
      });
    }

    await insertChunks(chatIds.map((conversationId, index) => ({
      orgId,
      conversationId,
      userId: boardUserId,
      lastReadAt: atMinutesAgo(scale.chats + index + 10),
    })), (chunk) => db.insert(chatConversationUserStates).values(chunk));

    const chatMessageRows = chatIds.flatMap((conversationId, chatIndex) =>
      Array.from({ length: conversationId === hotChatId ? 0 : scale.chatMessagesPerChat }, (_, messageIndex) => ({
        orgId,
        conversationId,
        role: messageIndex % 2 === 0 ? "assistant" : "user",
        kind: "message",
        status: "completed",
        body: `Perf chat message ${messageIndex + 1} in chat ${chatIndex + 1}.`,
        createdAt: atMinutesAgo(chatIndex + messageIndex),
      })));
    await insertChunks(chatMessageRows, (chunk) => db.insert(chatMessages).values(chunk));
    if (hotChatId) {
      const baseHotChatMessageCount = Math.max(
        0,
        scale.hotChatMessages - THREAD_PRESSURE_RECIPE.alternateVariantRows,
      );
      const turnIds = Array.from(
        { length: Math.ceil(baseHotChatMessageCount / THREAD_PRESSURE_RECIPE.chatTurnWidth) },
        () => randomUUID(),
      );
      await insertGeneratedChunks(
        baseHotChatMessageCount,
        (index) => {
          const id = randomUUID();
          hotChatMessageIds.push(id);
          const transcriptEntryCount = index % THREAD_PRESSURE_RECIPE.transcriptEvery === 0
            ? THREAD_PRESSURE_RECIPE.transcriptEntries
            : 0;
          return {
            id,
            orgId,
            conversationId: hotChatId,
            role: index % 2 === 0 ? "user" : "assistant",
            kind: index % 97 === 0 ? "system" : "message",
            status: index === baseHotChatMessageCount - 1 ? "streaming" : "completed",
            body: pressureBody("chat", index),
            structuredPayload: transcriptEntryCount > 0
              ? {
                  benchmarkEvidence: {
                    index,
                    references: ["issue", "run", "attachment"],
                  },
                  __chatTranscript: Array.from({ length: transcriptEntryCount }, (_, transcriptIndex) => ({
                    kind: transcriptIndex % 3 === 0 ? "thinking" : "assistant",
                    ts: pressureTimestamp(options.anchor, index + transcriptIndex).toISOString(),
                    text: `Transcript evidence ${index + 1}.${transcriptIndex + 1}`,
                  })),
                }
              : null,
            chatTurnId: turnIds[Math.floor(index / THREAD_PRESSURE_RECIPE.chatTurnWidth)],
            turnVariant: 0,
            supersededAt: null,
            createdAt: pressureTimestamp(options.anchor, index),
            updatedAt: pressureTimestamp(options.anchor, index),
          };
        },
        (chunk) => db.insert(chatMessages).values(chunk),
      );

      const alternateTurnIndex = Math.max(0, Math.floor(scale.hotChatMessages / 3));
      const alternateTurnId = turnIds[Math.floor(
        alternateTurnIndex / THREAD_PRESSURE_RECIPE.chatTurnWidth,
      )]!;
      const alternateCreatedAt = pressureTimestamp(options.anchor, alternateTurnIndex);
      const alternateUserMessageId = randomUUID();
      const alternateAssistantMessageId = randomUUID();
      hotChatMessageIds.push(alternateUserMessageId, alternateAssistantMessageId);
      await db.insert(chatMessages).values([
        {
          id: alternateUserMessageId,
          orgId,
          conversationId: hotChatId,
          role: "user",
          kind: "message",
          status: "completed",
          body: "Edited user prompt alternate variant.",
          chatTurnId: alternateTurnId,
          turnVariant: 1,
          supersededAt: new Date(alternateCreatedAt.getTime() + 1),
          createdAt: alternateCreatedAt,
          updatedAt: alternateCreatedAt,
        },
        {
          id: alternateAssistantMessageId,
          orgId,
          conversationId: hotChatId,
          role: "assistant",
          kind: "message",
          status: "completed",
          body: "Assistant reply for alternate variant.",
          chatTurnId: alternateTurnId,
          turnVariant: 1,
          supersededAt: new Date(alternateCreatedAt.getTime() + 1),
          createdAt: alternateCreatedAt,
          updatedAt: alternateCreatedAt,
        },
      ]);
    }
    if (neighborOrgId && neighborChatId) {
      await insertGeneratedChunks(
        scale.neighborOrgSentinels,
        (index) => ({
          orgId: neighborOrgId,
          conversationId: neighborChatId,
          role: index % 2 === 0 ? "assistant" : "user",
          kind: "message",
          status: "completed",
          body: pressureBody("chat", index),
          createdAt: pressureTimestamp(options.anchor, index),
          updatedAt: pressureTimestamp(options.anchor, index),
        }),
        (chunk) => db.insert(chatMessages).values(chunk),
      );
    }
    if (neighborOrgId && hotChatId) {
      await insertGeneratedChunks(
        scale.neighborOrgSentinels,
        (index) => ({
          orgId: neighborOrgId,
          conversationId: hotChatId,
          role: "assistant",
          kind: "message",
          status: "completed",
          body: `Cross-organization chat sentinel ${index + 1}.`,
          createdAt: pressureTimestamp(options.anchor, index),
          updatedAt: pressureTimestamp(options.anchor, index),
        }),
        (chunk) => db.insert(chatMessages).values(chunk),
      );
    }

    await insertChunks(approvalIds.map((id, index) => ({
      id,
      orgId,
      type: index % 2 === 0 ? "chat_issue_creation" : "hire_agent",
      status: index % 3 === 0 ? "pending" : "approved",
      requestedByUserId: boardUserId,
      payload: { name: `Approval ${index + 1}`, proposedIssue: { title: `Approval issue ${index + 1}` } },
      updatedAt: atMinutesAgo(scale.approvals - index),
      createdAt: atMinutesAgo(scale.approvals + index),
    })), (chunk) => db.insert(approvals).values(chunk));

    const approvalCommentRows = approvalIds.flatMap((approvalId, approvalIndex) =>
      Array.from({ length: scale.approvalCommentsPerApproval }, (_, commentIndex) => ({
        orgId,
        approvalId,
        authorUserId: boardUserId,
        body: `Approval comment ${commentIndex + 1} for approval ${approvalIndex + 1}.`,
        createdAt: atMinutesAgo(approvalIndex + commentIndex),
      })));
    await insertChunks(approvalCommentRows, (chunk) => db.insert(approvalComments).values(chunk));

    await insertChunks(Array.from({ length: scale.failedRuns }, (_, index) => ({
      orgId,
      agentId: agentIds[index % agentIds.length],
      invocationSource: "on_demand",
      status: index % 2 === 0 ? "failed" : "succeeded",
      error: index % 2 === 0 ? `Perf failure ${index + 1}` : null,
      createdAt: atMinutesAgo(scale.failedRuns - index),
      updatedAt: atMinutesAgo(scale.failedRuns - index),
    })), (chunk) => db.insert(heartbeatRuns).values(chunk));
    if (hotIssueId) {
      await insertGeneratedChunks(
        scale.hotIssueRuns,
        (index) => {
          const id = randomUUID();
          hotIssueRunIds.push(id);
          const activityOnly = index % THREAD_PRESSURE_RECIPE.activityOnlyRunEvery === 0;
          if (activityOnly) activityOnlyHotIssueRunIds.push(id);
          const status = index < THREAD_PRESSURE_RECIPE.activeRunStatuses.length
            ? THREAD_PRESSURE_RECIPE.activeRunStatuses[index]!
            : THREAD_PRESSURE_RECIPE.terminalRunStatuses[
              index % THREAD_PRESSURE_RECIPE.terminalRunStatuses.length
            ]!;
          const createdAt = pressureTimestamp(options.anchor, index);
          const terminal = status !== "queued" && status !== "running";
          return {
            id,
            orgId,
            agentId: agentIds[index % agentIds.length],
            invocationSource: "issue_assignment",
            triggerDetail: `thread-heavy run ${index + 1}`,
            status,
            startedAt: status === "queued" ? null : createdAt,
            finishedAt: terminal ? new Date(createdAt.getTime() + 30_000) : null,
            error: status === "failed" || status === "timed_out" ? `Pressure failure ${index + 1}` : null,
            stdoutExcerpt: `Pressure run ${index + 1} output. ${"evidence ".repeat(index % 20)}`,
            usageJson: { inputTokens: 1_000 + index, outputTokens: 100 + (index % 50) },
            resultSummaryJson: terminal ? { summary: `Pressure result ${index + 1}` } : null,
            contextSnapshot: {
              ...(activityOnly ? {} : { issueId: hotIssueId, taskId: hotIssueId }),
              benchmark: "thread-heavy",
            },
            terminalEffectsPending: false,
            createdAt,
            updatedAt: createdAt,
          };
        },
        (chunk) => db.insert(heartbeatRuns).values(chunk),
      );
      await insertChunks(activityOnlyHotIssueRunIds.map((runId, index) => ({
        orgId,
        actorType: "agent",
        actorId: agentIds[(index * THREAD_PRESSURE_RECIPE.activityOnlyRunEvery) % agentIds.length]!,
        action: "run.linked",
        entityType: "issue",
        entityId: hotIssueId,
        agentId: agentIds[(index * THREAD_PRESSURE_RECIPE.activityOnlyRunEvery) % agentIds.length]!,
        runId,
        details: { benchmark: "thread-heavy", linkage: "activity-only" },
        createdAt: pressureTimestamp(
          options.anchor,
          index * THREAD_PRESSURE_RECIPE.activityOnlyRunEvery,
        ),
      })), (chunk) => db.insert(activityLog).values(chunk));
    }
    if (neighborOrgId && neighborIssueId && neighborAgentId) {
      await insertGeneratedChunks(
        scale.neighborOrgSentinels,
        (index) => ({
          orgId: neighborOrgId,
          agentId: neighborAgentId,
          invocationSource: "issue_assignment",
          status: "succeeded",
          startedAt: pressureTimestamp(options.anchor, index),
          finishedAt: pressureTimestamp(options.anchor, index + 1),
          contextSnapshot: { issueId: neighborIssueId, taskId: neighborIssueId },
          createdAt: pressureTimestamp(options.anchor, index),
          updatedAt: pressureTimestamp(options.anchor, index),
        }),
        (chunk) => db.insert(heartbeatRuns).values(chunk),
      );
    }
    if (neighborOrgId && neighborAgentId && hotIssueId) {
      await insertGeneratedChunks(
        scale.neighborOrgSentinels,
        (index) => ({
          orgId: neighborOrgId,
          agentId: neighborAgentId,
          invocationSource: "issue_assignment",
          status: "succeeded",
          startedAt: pressureTimestamp(options.anchor, index),
          finishedAt: pressureTimestamp(options.anchor, index + 1),
          contextSnapshot: { issueId: hotIssueId, taskId: hotIssueId },
          createdAt: pressureTimestamp(options.anchor, index),
          updatedAt: pressureTimestamp(options.anchor, index),
        }),
        (chunk) => db.insert(heartbeatRuns).values(chunk),
      );
    }

    await insertChunks(inviteIds.map((id, index) => ({
      id,
      orgId,
      tokenHash: `perf-token-${id}`,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000),
      createdAt: atMinutesAgo(index),
    })), (chunk) => db.insert(invites).values(chunk));
    await insertChunks(inviteIds.map((inviteId, index) => ({
      inviteId,
      orgId,
      requestType: "agent",
      status: "pending_approval",
      requestIp: "127.0.0.1",
      agentName: `Joining Agent ${index + 1}`,
      capabilities: "Perf seeded join request.",
      createdAt: atMinutesAgo(index),
      updatedAt: atMinutesAgo(index),
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
      occurredAt: atMinutesAgo(index),
    })), (chunk) => db.insert(costEvents).values(chunk));

    await db.execute(sql`
      insert into cost_monthly_spend_rollups (
        org_id,
        scope_type,
        scope_id,
        month_start,
        spend_cents,
        created_at,
        updated_at
      )
      select
        cost_events.org_id,
        'organization',
        cost_events.org_id::text,
        (date_trunc('month', cost_events.occurred_at at time zone 'UTC') at time zone 'UTC') as month_start,
        coalesce(sum(cost_events.cost_cents), 0)::int,
        now(),
        now()
      from cost_events
      where cost_events.org_id = ${orgId}
      group by cost_events.org_id, (date_trunc('month', cost_events.occurred_at at time zone 'UTC') at time zone 'UTC')
      on conflict (org_id, scope_type, scope_id, month_start)
      do update set
        spend_cents = excluded.spend_cents,
        updated_at = now()
    `);
    await db.execute(sql`
      insert into cost_monthly_spend_rollups (
        org_id,
        scope_type,
        scope_id,
        month_start,
        spend_cents,
        created_at,
        updated_at
      )
      select
        cost_events.org_id,
        'agent',
        cost_events.agent_id::text,
        (date_trunc('month', cost_events.occurred_at at time zone 'UTC') at time zone 'UTC') as month_start,
        coalesce(sum(cost_events.cost_cents), 0)::int,
        now(),
        now()
      from cost_events
      where cost_events.org_id = ${orgId}
      group by cost_events.org_id, cost_events.agent_id, (date_trunc('month', cost_events.occurred_at at time zone 'UTC') at time zone 'UTC')
      on conflict (org_id, scope_type, scope_id, month_start)
      do update set
        spend_cents = excluded.spend_cents,
        updated_at = now()
    `);

    const sidebar = sidebarBadgeService(db);
    const messenger = messengerService(db);
    const costs = costService(db);
    const chats = chatService(db);
    const issueCommentsService = issueService(db);
    const activity = activityService(db);
    const samples: TimingSample[] = [];

    await db.execute(sql`analyze chat_messages, issue_comments, heartbeat_runs`);

    const runMeasuredPaths = async (index: number, collect: boolean) => {
      const measurements = [
        await timed("sidebar.getBaseCounts", () => sidebar.getBaseCounts(orgId)),
        await timed("sidebar.countUnreadTouchedIssues", () => sidebar.countUnreadTouchedIssues(orgId, boardUserId)),
        await timed("sidebar.countActiveChatAttention", () => sidebar.countActiveChatAttention(orgId, boardUserId)),
        await timed("messenger.listThreadSummaries", () => messenger.listThreadSummaries(orgId, boardUserId)),
        await timed("costs.createEvent", () => costs.createEvent(orgId, {
          agentId: agentIds[index % agentIds.length],
          provider: "openai",
          model: "gpt-5",
          inputTokens: 1_000,
          cachedInputTokens: 500,
          outputTokens: 200,
          costCents: 3,
          occurredAt: new Date(),
        })),
        ...(hotChatId
          ? [await timed("chat.listMessages.hot", () => chats.listMessages(hotChatId, { includeTranscript: false }))]
          : []),
        ...(hotIssueId
          ? [
              await timed("issue.listComments.hot", () => issueCommentsService.listComments(hotIssueId, { order: "asc" })),
              await timed("activity.runsForIssue.hot", () => activity.runsForIssue(orgId, hotIssueId)),
            ]
          : []),
      ];
      if (collect) {
        samples.push(...measurements.map(({ name, ms }) => ({ name, ms })));
      }
    };

    for (let index = 0; index < options.warmups; index += 1) {
      await runMeasuredPaths(index, false);
    }
    const memoryBefore = memorySnapshot();
    for (let index = 0; index < options.iterations; index += 1) {
      await runMeasuredPaths(index + options.warmups, true);
    }
    const memoryAfter = memorySnapshot();

    const gates: Array<ReturnType<typeof evaluateSequenceGates>> = [];
    const responses: Record<string, { rows: number; serializedBytes: number }> = {};
    if (hotChatId) {
      const messages = await chats.listMessages(hotChatId, { includeTranscript: false });
      responses["chat.listMessages.hot"] = {
        rows: messages.length,
        serializedBytes: serializedBytes(messages),
      };
      gates.push(evaluateSequenceGates({
        name: "chat.listMessages.hot",
        expectedCount: scale.hotChatMessages,
        expectedIds: hotChatMessageIds,
        expectedOrgId: orgId,
        expectedParentId: hotChatId,
        rows: messages.map((message) => ({
          id: message.id,
          orgId: message.orgId,
          parentId: message.conversationId,
          createdAt: message.createdAt,
        })),
        order: "asc",
      }));
    }
    if (neighborOrgId) {
      const summaries = await messenger.listThreadSummaries(orgId, boardUserId);
      const serializedSummaries = JSON.stringify(summaries);
      const forbiddenTokens = [
        neighborOrgId,
        neighborChatId,
        neighborIssueId,
        "Cross-organization",
        "Neighbor pressure",
      ].filter((value): value is string => Boolean(value));
      const leakedTokens = forbiddenTokens.filter((token) => serializedSummaries.includes(token));
      responses["messenger.listThreadSummaries.isolation"] = {
        rows: summaries.length,
        serializedBytes: serializedBytes(summaries),
      };
      gates.push({
        name: "messenger.listThreadSummaries.isolation",
        passed: leakedTokens.length === 0,
        count: summaries.length,
        violations: leakedTokens.length > 0
          ? [`messenger.listThreadSummaries.isolation:leaked_tokens=${leakedTokens.length}`]
          : [],
      });
    }
    if (hotIssueId) {
      const [comments, runs] = await Promise.all([
        issueCommentsService.listComments(hotIssueId, { order: "asc" }),
        activity.runsForIssue(orgId, hotIssueId),
      ]);
      responses["issue.listComments.hot"] = {
        rows: comments.length,
        serializedBytes: serializedBytes(comments),
      };
      responses["activity.runsForIssue.hot"] = {
        rows: runs.length,
        serializedBytes: serializedBytes(runs),
      };
      gates.push(evaluateSequenceGates({
        name: "issue.listComments.hot",
        expectedCount: scale.hotIssueComments,
        expectedIds: hotIssueCommentIds,
        expectedOrgId: orgId,
        expectedParentId: hotIssueId,
        rows: comments.map((comment) => ({
          id: comment.id,
          orgId: comment.orgId,
          parentId: comment.issueId,
          createdAt: comment.createdAt,
        })),
        order: "asc",
      }));
      const expectedHotIssueRunIds = new Set(hotIssueRunIds);
      gates.push(evaluateSequenceGates({
        name: "activity.runsForIssue.hot",
        expectedCount: scale.hotIssueRuns,
        expectedIds: hotIssueRunIds,
        expectedOrgId: orgId,
        expectedParentId: hotIssueId,
        rows: runs.map((run) => {
          return {
            id: run.runId,
            orgId,
            parentId: expectedHotIssueRunIds.has(run.runId) ? hotIssueId : null,
            createdAt: run.createdAt,
          };
        }),
        order: "desc",
      }));
    }
    if (options.explain) {
      await db.execute(sql`analyze`);
    }
    const explainPlans = options.explain
      ? await explainOptimizedPaths(
          db,
          orgId,
          boardUserId,
          agentIds[0]!,
          hotChatId,
          hotIssueId,
        )
      : undefined;

    console.log(JSON.stringify({
      orgId,
      neighborOrgId,
      hotEntities: {
        chatId: hotChatId,
        issueId: hotIssueId,
      },
      scale: options.scale,
      workload: {
        manifestVersion: WORKLOAD_MANIFEST_VERSION,
        manifestHash: workloadManifestHash(options.scale),
        anchor: options.anchor.toISOString(),
      },
      rows: {
        agents: scale.agents,
        issues: scale.issues,
        issueComments: issueCommentRows.length + scale.hotIssueComments,
        chats: scale.chats,
        chatMessages: chatMessageRows.length + scale.hotChatMessages,
        approvals: scale.approvals,
        approvalComments: approvalCommentRows.length,
        heartbeatRuns: scale.failedRuns + scale.hotIssueRuns,
        joinRequests: scale.joinRequests,
        costEvents: scale.costEvents + options.warmups + options.iterations,
        neighborSentinelsPerEntity: scale.neighborOrgSentinels,
        crossOrgParentSentinelsPerEntity: scale.neighborOrgSentinels,
        activityOnlyHotIssueRuns: activityOnlyHotIssueRunIds.length,
      },
      warmups: options.warmups,
      iterations: options.iterations,
      timings: summarizeTimingSamples(samples),
      responses,
      memoryDelta: memoryDelta(memoryBefore, memoryAfter),
      gates,
      passed: gates.every((gate) => gate.passed),
      ...(explainPlans ? { explainPlans } : {}),
    }, null, 2));
    const failedGates = gates.flatMap((gate) => gate.violations);
    if (failedGates.length > 0) {
      throw new Error(`Performance correctness gates failed: ${failedGates.join("; ")}`);
    }
  } finally {
    if (!options.keepData) {
      const cleanupOrgIds = neighborOrgId ? [orgId, neighborOrgId] : [orgId];
      await db.delete(costEvents).where(inArray(costEvents.orgId, cleanupOrgIds));
      await db.delete(costMonthlySpendRollups).where(inArray(costMonthlySpendRollups.orgId, cleanupOrgIds));
      await db.delete(messengerThreadUserStates).where(inArray(messengerThreadUserStates.orgId, cleanupOrgIds));
      await db.delete(chatConversationUserStates).where(inArray(chatConversationUserStates.orgId, cleanupOrgIds));
      await db.delete(chatMessages).where(inArray(chatMessages.orgId, cleanupOrgIds));
      await db.delete(chatConversations).where(inArray(chatConversations.orgId, cleanupOrgIds));
      await db.delete(approvalComments).where(inArray(approvalComments.orgId, cleanupOrgIds));
      await db.delete(approvals).where(inArray(approvals.orgId, cleanupOrgIds));
      await db.delete(joinRequests).where(inArray(joinRequests.orgId, cleanupOrgIds));
      await db.delete(invites).where(inArray(invites.orgId, cleanupOrgIds));
      await db.delete(activityLog).where(inArray(activityLog.orgId, cleanupOrgIds));
      await db.delete(heartbeatRuns).where(inArray(heartbeatRuns.orgId, cleanupOrgIds));
      await db.delete(issueReadStates).where(inArray(issueReadStates.orgId, cleanupOrgIds));
      await db.delete(issueComments).where(inArray(issueComments.orgId, cleanupOrgIds));
      await db.delete(issues).where(inArray(issues.orgId, cleanupOrgIds));
      await db.delete(agents).where(inArray(agents.orgId, cleanupOrgIds));
      await db.delete(organizations).where(inArray(organizations.id, cleanupOrgIds));
    }
    await (db as unknown as { $client?: { end?: (options?: { timeout?: number }) => Promise<void> } })
      .$client?.end?.({ timeout: 1 });
  }
}

await main();
