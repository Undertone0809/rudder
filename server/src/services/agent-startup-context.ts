import type { Db } from "@rudderhq/db";
import { chatContextLinks, chatConversations, chatMessages, issues } from "@rudderhq/db";
import type { AgentRunScene } from "@rudderhq/shared";
import { and, desc, eq, or, sql, type SQLWrapper } from "drizzle-orm";
import fs from "node:fs/promises";
import path from "node:path";

export const AGENT_STARTUP_CONTEXT_VERSION = "agent-startup-context/v1";

export const DEFAULT_AGENT_STARTUP_CONTEXT_LIMITS = {
  totalChars: 12_000,
  memoryFileChars: 2_000,
  issueSnippetChars: 360,
  chatSnippetChars: 360,
};

export type AgentStartupMemoryEntry = {
  dateKey: string;
  relativePath: string;
  content: string;
  existed: boolean;
  created: boolean;
  error?: string;
};

export type AgentStartupIssueEntry = {
  id: string;
  identifier: string | null;
  status: string;
  role: string;
  assignee: string | null;
  reviewer: string | null;
  title: string;
  snippet: string | null;
  createdAt: Date | string | null;
  updatedAt: Date | string | null;
};

export type AgentStartupChatEntry = {
  id: string;
  activityAt: Date | string | null;
  title: string;
  snippet: string | null;
};

export type AgentStartupContextPromptInput = {
  todayMemory: AgentStartupMemoryEntry;
  yesterdayMemory: AgentStartupMemoryEntry;
  recentIssues: AgentStartupIssueEntry[];
  recentChats: AgentStartupChatEntry[];
  metrics: {
    version: string;
    totalChars: number;
    limitChars: number;
    omittedIssues: number;
    omittedChats: number;
  };
};

export type AgentStartupContextLimits = Partial<typeof DEFAULT_AGENT_STARTUP_CONTEXT_LIMITS>;

export type BuildAgentStartupContextInput = {
  orgId: string;
  agentId: string;
  agentHome: string;
  memoryDir: string;
  scene: AgentRunScene;
  issueId?: string | null;
  projectId?: string | null;
  chatConversationId?: string | null;
  now?: Date;
};

export type AgentStartupContextBundle = {
  version: typeof AGENT_STARTUP_CONTEXT_VERSION;
  sections: string[];
  sourceRefs: Array<{ kind: "memory" | "issue" | "chat"; id: string; ref: string }>;
  markdown: string;
  metrics: {
    version: typeof AGENT_STARTUP_CONTEXT_VERSION;
    totalChars: number;
    limitChars: number;
    recentIssuesCount: number;
    recentChatsCount: number;
    omittedIssues: number;
    omittedChats: number;
  };
  omissions: string[];
};

function compactSingleLine(value: string | null | undefined) {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function clip(value: string | null | undefined, maxChars: number) {
  const compact = compactSingleLine(value);
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function clipMarkdown(value: string | null | undefined, maxChars: number) {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return "(empty)";
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function formatDate(value: Date | string | null) {
  if (!value) return "unknown";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "unknown" : date.toISOString();
}

function markdownTableCell(value: string | null | undefined) {
  const compact = compactSingleLine(value);
  if (!compact) return "empty";
  return compact.replace(/\|/g, "\\|");
}

function markdownCodeCell(value: string | null | undefined) {
  const compact = markdownTableCell(value);
  return compact === "empty" ? "empty" : `\`${compact.replace(/`/g, "'")}\``;
}

function appendMarkdownTable(lines: string[], headers: string[], rows: string[][]) {
  lines.push(`| ${headers.join(" | ")} |`);
  lines.push(`| ${headers.map(() => "---").join(" | ")} |`);
  rows.forEach((row) => {
    lines.push(`| ${row.join(" | ")} |`);
  });
}

function formatIssuePrincipal(agentId: string | null | undefined, userId: string | null | undefined) {
  if (agentId) return `agent:${agentId}`;
  if (userId) return `user:${userId}`;
  return null;
}

export function buildAgentStartupContextPrompt(
  input: AgentStartupContextPromptInput,
  limits: AgentStartupContextLimits = {},
) {
  const resolvedLimits = { ...DEFAULT_AGENT_STARTUP_CONTEXT_LIMITS, ...limits };
  const hasDailyMemory =
    input.todayMemory.content.trim().length > 0
    || input.yesterdayMemory.content.trim().length > 0;
  if (!hasDailyMemory && input.recentIssues.length === 0 && input.recentChats.length === 0) {
    return "";
  }
  const lines = [
    "## Recent Rudder Context",
    "",
    `#### today ${input.todayMemory.relativePath}`,
    clipMarkdown(input.todayMemory.content, resolvedLimits.memoryFileChars),
    "",
    `#### yesterday ${input.yesterdayMemory.relativePath}`,
    clipMarkdown(input.yesterdayMemory.content, resolvedLimits.memoryFileChars),
    "",
    "#### recent issues",
  ];
  if (input.recentIssues.length === 0) lines.push("(none)");
  else {
    appendMarkdownTable(lines, [
      "Issue",
      "Status",
      "Role",
      "Assignee",
      "Reviewer",
      "Created",
      "Updated",
      "Title",
      "Summary",
    ], input.recentIssues.map((issue) => [
      markdownCodeCell(issue.identifier ?? issue.id),
      markdownCodeCell(issue.status),
      markdownTableCell(issue.role),
      markdownTableCell(issue.assignee),
      markdownTableCell(issue.reviewer),
      markdownTableCell(formatDate(issue.createdAt)),
      markdownTableCell(formatDate(issue.updatedAt)),
      markdownTableCell(clip(issue.title, 120)),
      markdownTableCell(clip(issue.snippet, resolvedLimits.issueSnippetChars)),
    ]));
  }
  lines.push("", "#### recent chats");
  if (input.recentChats.length === 0) lines.push("(none)");
  else {
    appendMarkdownTable(lines, [
      "Chat",
      "Last active",
      "Title",
      "Summary",
    ], input.recentChats.map((chat) => [
      markdownCodeCell(chat.id),
      markdownTableCell(formatDate(chat.activityAt)),
      markdownTableCell(clip(chat.title, 120)),
      markdownTableCell(clip(chat.snippet, resolvedLimits.chatSnippetChars)),
    ]));
  }
  let prompt = lines.join("\n");
  if (prompt.length <= resolvedLimits.totalChars) return prompt;
  const suffix = "\n\n[Recent Rudder Context truncated by char limit]";
  const bodyLimit = Math.max(0, resolvedLimits.totalChars - suffix.length - 4);
  return `${prompt.slice(0, bodyLimit).trimEnd()}...\n${suffix}`;
}

function utcDateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function addUtcDays(date: Date, days: number) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

async function ensureMemoryEntry(memoryDir: string, dateKey: string): Promise<AgentStartupMemoryEntry> {
  const filePath = path.join(memoryDir, `${dateKey}.md`);
  const relativePath = `memory/${dateKey}.md`;
  try {
    await fs.mkdir(memoryDir, { recursive: true });
  } catch (error) {
    return {
      dateKey,
      relativePath,
      content: "",
      existed: false,
      created: false,
      error: `mkdir failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  let existed = true;
  let created = false;
  try {
    await fs.access(filePath);
  } catch {
    existed = false;
    created = true;
    try {
      await fs.writeFile(filePath, "", "utf8");
    } catch (error) {
      return {
        dateKey,
        relativePath,
        content: "",
        existed,
        created: false,
        error: `create failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  try {
    const content = await fs.readFile(filePath, "utf8");
    return { dateKey, relativePath, content, existed, created };
  } catch (error) {
    return {
      dateKey,
      relativePath,
      content: "",
      existed,
      created,
      error: `read failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function hasDbSelect(db: Db) {
  return typeof (db as Partial<Db>).select === "function";
}

function issueRole(row: { assigneeAgentId: string | null; reviewerAgentId: string | null; createdByAgentId: string | null }, agentId: string) {
  if (row.assigneeAgentId === agentId) return "assignee";
  if (row.reviewerAgentId === agentId) return "reviewer";
  if (row.createdByAgentId === agentId) return "creator";
  return "linked";
}

async function listRecentIssues(db: Db, input: BuildAgentStartupContextInput) {
  if (!hasDbSelect(db)) return { items: [] as AgentStartupIssueEntry[], omitted: 0 };
  const involvement: SQLWrapper[] = [
    eq(issues.assigneeAgentId, input.agentId),
    eq(issues.reviewerAgentId, input.agentId),
    eq(issues.createdByAgentId, input.agentId),
  ];
  if (input.issueId) involvement.push(eq(issues.id, input.issueId));
  const rows = await db.select({
    id: issues.id,
    identifier: issues.identifier,
    status: issues.status,
    title: issues.title,
    description: issues.description,
    assigneeAgentId: issues.assigneeAgentId,
    assigneeUserId: issues.assigneeUserId,
    reviewerAgentId: issues.reviewerAgentId,
    reviewerUserId: issues.reviewerUserId,
    createdByAgentId: issues.createdByAgentId,
    createdAt: issues.createdAt,
    updatedAt: issues.updatedAt,
  }).from(issues)
    .where(and(eq(issues.orgId, input.orgId), or(...involvement)!))
    .orderBy(desc(issues.updatedAt), desc(issues.createdAt), desc(issues.id))
    .limit(11);
  return {
    items: rows.slice(0, 10).map((row) => ({
      id: row.id,
      identifier: row.identifier,
      status: row.status,
      role: issueRole(row, input.agentId),
      assignee: formatIssuePrincipal(row.assigneeAgentId, row.assigneeUserId),
      reviewer: formatIssuePrincipal(row.reviewerAgentId, row.reviewerUserId),
      title: row.title,
      snippet: row.description,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })),
    omitted: Math.max(0, rows.length - 10),
  };
}

async function listRecentChats(db: Db, input: BuildAgentStartupContextInput) {
  if (!hasDbSelect(db)) return { items: [] as AgentStartupChatEntry[], omitted: 0 };
  const linkedTo = (entityType: string, entityId: string) => sql<boolean>`exists (
    select 1
    from ${chatContextLinks}
    where ${chatContextLinks.orgId} = ${input.orgId}
      and ${chatContextLinks.conversationId} = ${chatConversations.id}
      and ${chatContextLinks.entityType} = ${entityType}
      and ${chatContextLinks.entityId} = ${entityId}
  )`;
  const involvement: SQLWrapper[] = [
    eq(chatConversations.preferredAgentId, input.agentId),
    eq(chatConversations.routedAgentId, input.agentId),
    linkedTo("agent", input.agentId),
  ];
  if (input.chatConversationId && input.scene !== "chat") involvement.push(eq(chatConversations.id, input.chatConversationId));
  if (input.issueId) involvement.push(linkedTo("issue", input.issueId));
  if (input.projectId) involvement.push(linkedTo("project", input.projectId));
  const filters: SQLWrapper[] = [eq(chatConversations.orgId, input.orgId), or(...involvement)!];
  if (input.scene === "chat" && input.chatConversationId) {
    filters.push(sql`${chatConversations.id} <> ${input.chatConversationId}`);
  }
  const rows = await db.select({
    id: chatConversations.id,
    title: chatConversations.title,
    summary: chatConversations.summary,
    lastMessageAt: chatConversations.lastMessageAt,
    updatedAt: chatConversations.updatedAt,
    latestMessage: sql<string | null>`(
      select ${chatMessages.body}
      from ${chatMessages}
      where ${chatMessages.conversationId} = ${chatConversations.id}
        and ${chatMessages.orgId} = ${input.orgId}
        and ${chatMessages.supersededAt} is null
        and btrim(${chatMessages.body}) <> ''
      order by ${chatMessages.createdAt} desc, ${chatMessages.id} desc
      limit 1
    )`.as("latest_message"),
  }).from(chatConversations)
    .where(and(...filters))
    .orderBy(desc(sql`coalesce(${chatConversations.lastMessageAt}, ${chatConversations.updatedAt})`), desc(chatConversations.id))
    .limit(11);
  return {
    items: rows.slice(0, 10).map((row) => ({
      id: row.id,
      activityAt: row.lastMessageAt ?? row.updatedAt,
      title: row.title,
      snippet: row.latestMessage ?? row.summary,
    })),
    omitted: Math.max(0, rows.length - 10),
  };
}

export function agentStartupContextService(db: Db) {
  async function buildForRun(input: BuildAgentStartupContextInput): Promise<AgentStartupContextBundle> {
    const now = input.now ?? new Date();
    const todayKey = utcDateKey(now);
    const yesterdayKey = utcDateKey(addUtcDays(now, -1));
    const [todayMemory, yesterdayMemory, recentIssues, recentChats] = await Promise.all([
      ensureMemoryEntry(input.memoryDir, todayKey),
      ensureMemoryEntry(input.memoryDir, yesterdayKey),
      listRecentIssues(db, input),
      listRecentChats(db, input),
    ]);
    const promptInput: AgentStartupContextPromptInput = {
      todayMemory,
      yesterdayMemory,
      recentIssues: recentIssues.items,
      recentChats: recentChats.items,
      metrics: {
        version: AGENT_STARTUP_CONTEXT_VERSION,
        totalChars: 0,
        limitChars: DEFAULT_AGENT_STARTUP_CONTEXT_LIMITS.totalChars,
        omittedIssues: recentIssues.omitted,
        omittedChats: recentChats.omitted,
      },
    };
    const markdown = buildAgentStartupContextPrompt(promptInput);
    const metrics = {
      version: AGENT_STARTUP_CONTEXT_VERSION,
      totalChars: markdown.length,
      limitChars: DEFAULT_AGENT_STARTUP_CONTEXT_LIMITS.totalChars,
      recentIssuesCount: recentIssues.items.length,
      recentChatsCount: recentChats.items.length,
      omittedIssues: recentIssues.omitted,
      omittedChats: recentChats.omitted,
    } as const;
    return {
      version: AGENT_STARTUP_CONTEXT_VERSION,
      sections: ["daily_memory", "recent_issues", "recent_chats"],
      sourceRefs: [
        { kind: "memory", id: todayKey, ref: todayMemory.relativePath },
        { kind: "memory", id: yesterdayKey, ref: yesterdayMemory.relativePath },
        ...recentIssues.items.map((issue) => ({ kind: "issue" as const, id: issue.id, ref: issue.identifier ?? issue.id })),
        ...recentChats.items.map((chat) => ({ kind: "chat" as const, id: chat.id, ref: chat.id })),
      ],
      markdown,
      metrics,
      omissions: [
        ...(todayMemory.error ? [`${todayMemory.relativePath}: ${todayMemory.error}`] : []),
        ...(yesterdayMemory.error ? [`${yesterdayMemory.relativePath}: ${yesterdayMemory.error}`] : []),
        ...(recentIssues.omitted > 0 ? [`${recentIssues.omitted} older issues`] : []),
        ...(recentChats.omitted > 0 ? [`${recentChats.omitted} older chats`] : []),
      ],
    };
  }
  return { buildForRun };
}
