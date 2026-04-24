import { Command } from "commander";
import {
  addIssueCommentSchema,
  checkoutIssueSchema,
  createIssueSchema,
  updateIssueSchema,
  upsertIssueDocumentSchema,
  type DocumentRevision,
  type IssueDocument,
  type IssueDocumentSummary,
  type Issue,
  type IssueComment,
} from "@rudderhq/shared";
import {
  addCommonClientOptions,
  formatInlineRecord,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";
import { getAgentCliCapabilityById } from "../../agent-v1-registry.js";

interface IssueBaseOptions extends BaseClientOptions {
  status?: string;
  assigneeAgentId?: string;
  projectId?: string;
  match?: string;
}

interface IssueCreateOptions extends BaseClientOptions {
  title: string;
  description?: string;
  status?: string;
  priority?: string;
  assigneeAgentId?: string;
  projectId?: string;
  goalId?: string;
  parentId?: string;
  requestDepth?: string;
  billingCode?: string;
}

interface IssueUpdateOptions extends BaseClientOptions {
  title?: string;
  description?: string;
  status?: string;
  priority?: string;
  assigneeAgentId?: string;
  projectId?: string;
  goalId?: string;
  parentId?: string;
  requestDepth?: string;
  billingCode?: string;
  comment?: string;
  hiddenAt?: string;
}

interface IssueCommentOptions extends BaseClientOptions {
  body: string;
  reopen?: boolean;
}

interface IssueCheckoutOptions extends BaseClientOptions {
  agentId?: string;
  expectedStatuses?: string;
}

interface IssueStatusCommentOptions extends BaseClientOptions {
  comment: string;
}

interface IssueContextOptions extends BaseClientOptions {
  wakeCommentId?: string;
}

interface IssueCommentsListOptions extends BaseClientOptions {
  after?: string;
  order?: string;
}

interface IssueDocumentPutOptions extends BaseClientOptions {
  body: string;
  title?: string;
  format?: string;
  changeSummary?: string;
  baseRevisionId?: string;
}

interface IssueHeartbeatContext {
  issue: {
    id: string;
    identifier: string | null;
    title: string;
    description: string | null;
    status: string;
    priority: string;
    projectId: string | null;
    goalId: string | null;
    parentId: string | null;
    assigneeAgentId: string | null;
    assigneeUserId: string | null;
    updatedAt: string;
  };
  ancestors: Array<{
    id: string;
    identifier: string | null;
    title: string;
    status: string;
    priority: string;
  }>;
  project: {
    id: string;
    name: string;
    status: string;
    targetDate: string | null;
  } | null;
  goal: {
    id: string;
    title: string;
    status: string;
    level: string;
    parentId: string | null;
  } | null;
  commentCursor: {
    latestCommentId: string | null;
    latestCommentCreatedAt: string | null;
    commentCount: number;
  };
  wakeComment: IssueComment | null;
}

export function registerIssueCommands(program: Command): void {
  const issue = program.command("issue").description("Issue operations");

  addCommonClientOptions(
    issue
      .command("list")
      .description("List issues for an organization")
      .option("-O, --org-id <id>", "Organization ID")
      .option("--status <csv>", "Comma-separated statuses")
      .option("--assignee-agent-id <id>", "Filter by assignee agent ID")
      .option("--project-id <id>", "Filter by project ID")
      .option("--match <text>", "Local text match on identifier/title/description")
      .action(async (opts: IssueBaseOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const params = new URLSearchParams();
          if (opts.status) params.set("status", opts.status);
          if (opts.assigneeAgentId) params.set("assigneeAgentId", opts.assigneeAgentId);
          if (opts.projectId) params.set("projectId", opts.projectId);

          const query = params.toString();
          const path = `/api/orgs/${ctx.orgId}/issues${query ? `?${query}` : ""}`;
          const rows = (await ctx.api.get<Issue[]>(path)) ?? [];

          const filtered = filterIssueRows(rows, opts.match);
          if (ctx.json) {
            printOutput(filtered, { json: true });
            return;
          }

          if (filtered.length === 0) {
            printOutput([], { json: false });
            return;
          }

          for (const item of filtered) {
            console.log(
              formatInlineRecord({
                identifier: item.identifier,
                id: item.id,
                status: item.status,
                priority: item.priority,
                assigneeAgentId: item.assigneeAgentId,
                title: item.title,
                projectId: item.projectId,
              }),
            );
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    issue
      .command("get")
      .description(getAgentCliCapabilityById("issue.get").description)
      .argument("<idOrIdentifier>", "Issue ID or identifier")
      .action(async (idOrIdentifier: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<Issue>(`/api/issues/${idOrIdentifier}`);
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("context")
      .description(getAgentCliCapabilityById("issue.context").description)
      .argument("<issueId>", "Issue ID or identifier")
      .option("--wake-comment-id <id>", "Fetch one wake comment in the heartbeat context response")
      .action(async (issueId: string, opts: IssueContextOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const params = new URLSearchParams();
          if (opts.wakeCommentId) params.set("wakeCommentId", opts.wakeCommentId);
          const query = params.toString();
          const row = await ctx.api.get<IssueHeartbeatContext>(
            `/api/issues/${issueId}/heartbeat-context${query ? `?${query}` : ""}`,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("create")
      .description(getAgentCliCapabilityById("issue.create").description)
      .option("-O, --org-id <id>", "Organization ID")
      .requiredOption("--title <title>", "Issue title")
      .option("--description <text>", "Issue description")
      .option("--status <status>", "Issue status")
      .option("--priority <priority>", "Issue priority")
      .option("--assignee-agent-id <id>", "Assignee agent ID")
      .option("--project-id <id>", "Project ID")
      .option("--goal-id <id>", "Goal ID")
      .option("--parent-id <id>", "Parent issue ID")
      .option("--request-depth <n>", "Request depth integer")
      .option("--billing-code <code>", "Billing code")
      .action(async (opts: IssueCreateOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const payload = createIssueSchema.parse({
            title: opts.title,
            description: opts.description,
            status: opts.status,
            priority: opts.priority,
            assigneeAgentId: opts.assigneeAgentId,
            projectId: opts.projectId,
            goalId: opts.goalId,
            parentId: opts.parentId,
            requestDepth: parseOptionalInt(opts.requestDepth),
            billingCode: opts.billingCode,
          });

          const created = await ctx.api.post<Issue>(`/api/orgs/${ctx.orgId}/issues`, payload);
          printOutput(created, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    issue
      .command("update")
      .description(getAgentCliCapabilityById("issue.update").description)
      .argument("<issueId>", "Issue ID")
      .option("--title <title>", "Issue title")
      .option("--description <text>", "Issue description")
      .option("--status <status>", "Issue status")
      .option("--priority <priority>", "Issue priority")
      .option("--assignee-agent-id <id>", "Assignee agent ID")
      .option("--project-id <id>", "Project ID")
      .option("--goal-id <id>", "Goal ID")
      .option("--parent-id <id>", "Parent issue ID")
      .option("--request-depth <n>", "Request depth integer")
      .option("--billing-code <code>", "Billing code")
      .option("--comment <text>", "Optional comment to add with update")
      .option("--hidden-at <iso8601|null>", "Set hiddenAt timestamp or literal 'null'")
      .action(async (issueId: string, opts: IssueUpdateOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = updateIssueSchema.parse({
            title: opts.title,
            description: opts.description,
            status: opts.status,
            priority: opts.priority,
            assigneeAgentId: opts.assigneeAgentId,
            projectId: opts.projectId,
            goalId: opts.goalId,
            parentId: opts.parentId,
            requestDepth: parseOptionalInt(opts.requestDepth),
            billingCode: opts.billingCode,
            comment: opts.comment,
            hiddenAt: parseHiddenAt(opts.hiddenAt),
          });

          const updated = await ctx.api.patch<Issue & { comment?: IssueComment | null }>(`/api/issues/${issueId}`, payload);
          printOutput(updated, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("comment")
      .description(getAgentCliCapabilityById("issue.comment").description)
      .argument("<issueId>", "Issue ID")
      .requiredOption("--body <text>", "Comment body")
      .option("--reopen", "Reopen if issue is done/cancelled")
      .action(async (issueId: string, opts: IssueCommentOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = addIssueCommentSchema.parse({
            body: opts.body,
            reopen: opts.reopen,
          });
          const comment = await ctx.api.post<IssueComment>(`/api/issues/${issueId}/comments`, payload);
          printOutput(comment, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("done")
      .description(getAgentCliCapabilityById("issue.done").description)
      .argument("<issueId>", "Issue ID")
      .requiredOption("--comment <text>", "Required completion comment")
      .action(async (issueId: string, opts: IssueStatusCommentOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const updated = await ctx.api.patch<Issue>(`/api/issues/${issueId}`, {
            status: "done",
            comment: opts.comment,
          });
          printOutput(updated, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("block")
      .description(getAgentCliCapabilityById("issue.block").description)
      .argument("<issueId>", "Issue ID")
      .requiredOption("--comment <text>", "Required blocker comment")
      .action(async (issueId: string, opts: IssueStatusCommentOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const updated = await ctx.api.patch<Issue>(`/api/issues/${issueId}`, {
            status: "blocked",
            comment: opts.comment,
          });
          printOutput(updated, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  const comments = issue.command("comments").description("Issue comment operations");

  addCommonClientOptions(
    comments
      .command("list")
      .description(getAgentCliCapabilityById("issue.comments.list").description)
      .argument("<issueId>", "Issue ID")
      .option("--after <commentId>", "Only return comments after this comment ID")
      .option("--order <order>", "Comment ordering (asc or desc)", "desc")
      .action(async (issueId: string, opts: IssueCommentsListOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const params = new URLSearchParams();
          if (opts.after) params.set("after", opts.after);
          if (opts.order) params.set("order", opts.order);
          const query = params.toString();
          const rows = (await ctx.api.get<IssueComment[]>(
            `/api/issues/${issueId}/comments${query ? `?${query}` : ""}`,
          )) ?? [];
          printOutput(rows, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    comments
      .command("get")
      .description(getAgentCliCapabilityById("issue.comments.get").description)
      .argument("<issueId>", "Issue ID")
      .argument("<commentId>", "Comment ID")
      .action(async (issueId: string, commentId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<IssueComment>(`/api/issues/${issueId}/comments/${commentId}`);
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  const documents = issue.command("documents").description("Issue document operations");

  addCommonClientOptions(
    documents
      .command("list")
      .description(getAgentCliCapabilityById("issue.documents.list").description)
      .argument("<issueId>", "Issue ID")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const rows = (await ctx.api.get<IssueDocumentSummary[]>(`/api/issues/${issueId}/documents`)) ?? [];
          printOutput(rows, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    documents
      .command("get")
      .description(getAgentCliCapabilityById("issue.documents.get").description)
      .argument("<issueId>", "Issue ID")
      .argument("<key>", "Document key")
      .action(async (issueId: string, key: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<IssueDocument>(`/api/issues/${issueId}/documents/${key}`);
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    documents
      .command("put")
      .description(getAgentCliCapabilityById("issue.documents.put").description)
      .argument("<issueId>", "Issue ID")
      .argument("<key>", "Document key")
      .requiredOption("--body <text>", "Document body")
      .option("--title <text>", "Document title")
      .option("--format <format>", "Document format", "markdown")
      .option("--change-summary <text>", "Optional change summary")
      .option("--base-revision-id <id>", "Latest revision id for optimistic concurrency")
      .action(async (issueId: string, key: string, opts: IssueDocumentPutOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = upsertIssueDocumentSchema.parse({
            title: opts.title,
            format: opts.format,
            body: opts.body,
            changeSummary: opts.changeSummary,
            baseRevisionId: opts.baseRevisionId,
          });
          const row = await ctx.api.put<IssueDocument>(`/api/issues/${issueId}/documents/${key}`, payload);
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    documents
      .command("revisions")
      .description(getAgentCliCapabilityById("issue.documents.revisions").description)
      .argument("<issueId>", "Issue ID")
      .argument("<key>", "Document key")
      .action(async (issueId: string, key: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const rows = (await ctx.api.get<DocumentRevision[]>(`/api/issues/${issueId}/documents/${key}/revisions`)) ?? [];
          printOutput(rows, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("checkout")
      .description(getAgentCliCapabilityById("issue.checkout").description)
      .argument("<issueId>", "Issue ID")
      .option("--agent-id <id>", "Agent ID (defaults to RUDDER_AGENT_ID)")
      .option(
        "--expected-statuses <csv>",
        "Expected current statuses",
        "todo,backlog,blocked",
      )
      .action(async (issueId: string, opts: IssueCheckoutOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const agentId = opts.agentId?.trim() || ctx.agentId;
          if (!agentId) {
            throw new Error("Agent ID is required. Pass --agent-id or set RUDDER_AGENT_ID.");
          }
          const payload = checkoutIssueSchema.parse({
            agentId,
            expectedStatuses: parseCsv(opts.expectedStatuses),
          });
          const updated = await ctx.api.post<Issue>(`/api/issues/${issueId}/checkout`, payload);
          printOutput(updated, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("release")
      .description(getAgentCliCapabilityById("issue.release").description)
      .argument("<issueId>", "Issue ID")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const updated = await ctx.api.post<Issue>(`/api/issues/${issueId}/release`, {});
          printOutput(updated, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((v) => v.trim()).filter(Boolean);
}

function parseOptionalInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid integer value: ${value}`);
  }
  return parsed;
}

function parseHiddenAt(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value.trim().toLowerCase() === "null") return null;
  return value;
}

function filterIssueRows(rows: Issue[], match: string | undefined): Issue[] {
  if (!match?.trim()) return rows;
  const needle = match.trim().toLowerCase();
  return rows.filter((row) => {
    const text = [row.identifier, row.title, row.description]
      .filter((part): part is string => Boolean(part))
      .join("\n")
      .toLowerCase();
    return text.includes(needle);
  });
}
