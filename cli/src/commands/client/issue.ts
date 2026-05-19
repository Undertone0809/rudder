import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import {
  addIssueCommentSchema,
  checkoutIssueSchema,
  createIssueSchema,
  reportIssueCommitSchema,
  updateIssueSchema,
  upsertIssueDocumentSchema,
  type DocumentRevision,
  type IssueDocument,
  type IssueDocumentSummary,
  type LegacyPlanDocument,
  type Issue,
  type IssueAttachment,
  type IssueComment,
  type IssueCommitReport,
  type IssueLabel,
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
  query?: string;
  match?: string;
}

interface IssueSearchOptions extends BaseClientOptions {
  status?: string;
  assigneeAgentId?: string;
  projectId?: string;
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
  labelId?: string[];
  label?: string[];
}

interface IssueLabelsListOptions extends BaseClientOptions {}

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
  image?: string[];
  hiddenAt?: string;
}

interface IssueCommentOptions extends BaseClientOptions {
  body: string;
  image?: string[];
  reopen?: boolean;
}

interface IssueCommitOptions extends BaseClientOptions {
  sha: string;
  message: string;
  branch?: string;
  repoPath?: string;
  workspacePath?: string;
  count?: string;
}

interface IssueCheckoutOptions extends BaseClientOptions {
  agentId?: string;
  expectedStatuses?: string;
}

interface IssueStatusCommentOptions extends BaseClientOptions {
  comment: string;
  image?: string[];
}

interface IssueReviewOptions extends BaseClientOptions {
  decision: "approve" | "request_changes" | "needs_followup" | "blocked";
  comment: string;
}

type CommandContext = ReturnType<typeof resolveCommandContext>;

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
  planDocument: IssueDocument | null;
  documentSummaries: IssueDocumentSummary[];
  legacyPlanDocument: LegacyPlanDocument | null;
  issueDocumentsPrompt: string;
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
      .option("--query <text>", "Server-side search on identifier/title/description/comments")
      .option("--match <text>", "Local text match on identifier/title/description")
      .action(async (opts: IssueBaseOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = (await ctx.api.get<Issue[]>(buildIssueListPath(ctx.orgId!, opts, opts.query))) ?? [];
          const filtered = filterIssueRows(rows, opts.match);
          printIssueRows(filtered, ctx.json);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    issue
      .command("search")
      .description(getAgentCliCapabilityById("issue.search").description)
      .argument("<query>", "Server-side issue search query")
      .option("-O, --org-id <id>", "Organization ID")
      .option("--status <csv>", "Comma-separated statuses")
      .option("--assignee-agent-id <id>", "Filter by assignee agent ID")
      .option("--project-id <id>", "Filter by project ID")
      .action(async (query: string, opts: IssueSearchOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = (await ctx.api.get<Issue[]>(buildIssueListPath(ctx.orgId!, opts, query))) ?? [];
          printIssueRows(rows, ctx.json);
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
      .command("labels")
      .description("Issue label operations")
      .command("list")
      .description("List issue labels for an organization")
      .option("-O, --org-id <id>", "Organization ID")
      .action(async (opts: IssueLabelsListOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = (await ctx.api.get<IssueLabel[]>(`/api/orgs/${ctx.orgId}/labels`)) ?? [];
          printOutput(rows, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
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
      .option("--label-id <id>", "Issue label ID; may be repeated", collectNonEmptyOption("--label-id"), [] as string[])
      .option("--label <name>", "Issue label name to resolve exactly; may be repeated", collectNonEmptyOption("--label"), [] as string[])
      .action(async (opts: IssueCreateOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const labelIds = await resolveIssueLabelIds(ctx, opts);
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
            labelIds: labelIds.length > 0 ? labelIds : undefined,
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
      .option("--image <path>", "Image file to upload and append to the update comment; may be repeated", collectImagePath, [] as string[])
      .option("--hidden-at <iso8601|null>", "Set hiddenAt timestamp or literal 'null'")
      .action(async (issueId: string, opts: IssueUpdateOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const comment = await appendUploadedIssueImages(ctx, issueId, opts.comment, opts.image);
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
            comment,
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
      .option("--image <path>", "Image file to upload and append to the comment; may be repeated", collectImagePath, [] as string[])
      .option("--reopen", "Reopen if issue is done/cancelled")
      .action(async (issueId: string, opts: IssueCommentOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const body = await appendUploadedIssueImages(ctx, issueId, opts.body, opts.image);
          const payload = addIssueCommentSchema.parse({
            body,
            reopen: opts.reopen,
          });
          const comment = await ctx.api.post<IssueComment>(`/api/issues/${issueId}/comments`, payload);
          if (!isIssueCommentResponse(comment)) {
            throw new Error("Issue comment request completed without a persisted comment response");
          }
          printOutput(comment, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("review")
      .description(getAgentCliCapabilityById("issue.review").description)
      .argument("<issueId>", "Issue ID")
      .requiredOption(
        "--decision <decision>",
        "Review decision: approve, request_changes, needs_followup, or blocked",
      )
      .requiredOption("--comment <text>", "Required review comment")
      .action(async (issueId: string, opts: IssueReviewOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const decision = parseReviewDecision(opts.decision);
          const updated = await ctx.api.patch<Issue & { comment?: IssueComment | null }>(`/api/issues/${issueId}`, {
            reviewDecision: decision,
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
      .command("commit")
      .description(getAgentCliCapabilityById("issue.commit").description)
      .argument("<issueId>", "Issue ID")
      .requiredOption("--sha <sha>", "Commit SHA")
      .requiredOption("--message <subject>", "Commit subject or message")
      .option("--branch <name>", "Branch name")
      .option("--repo-path <path>", "Repository path")
      .option("--workspace-path <path>", "Workspace path")
      .option("--count <n>", "Number of commits represented by this report")
      .action(async (issueId: string, opts: IssueCommitOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = reportIssueCommitSchema.parse({
            sha: opts.sha,
            message: opts.message,
            branch: opts.branch,
            repoPath: opts.repoPath,
            workspacePath: opts.workspacePath,
            commitCount: parseOptionalInt(opts.count),
          });
          const reported = await ctx.api.post<IssueCommitReport>(`/api/issues/${issueId}/commit`, payload);
          printOutput(reported, { json: ctx.json });
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
      .option("--image <path>", "Image file to upload and append to the completion comment; may be repeated", collectImagePath, [] as string[])
      .action(async (issueId: string, opts: IssueStatusCommentOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const comment = await appendUploadedIssueImages(ctx, issueId, opts.comment, opts.image);
          const updated = await ctx.api.patch<Issue>(`/api/issues/${issueId}`, {
            status: "done",
            comment,
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
      .option("--image <path>", "Image file to upload and append to the blocker comment; may be repeated", collectImagePath, [] as string[])
      .action(async (issueId: string, opts: IssueStatusCommentOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const comment = await appendUploadedIssueImages(ctx, issueId, opts.comment, opts.image);
          const updated = await ctx.api.patch<Issue>(`/api/issues/${issueId}`, {
            status: "blocked",
            comment,
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

function collectImagePath(value: string, previous: string[]): string[] {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("--image path cannot be empty");
  }
  return [...previous, trimmed];
}

function collectNonEmptyOption(optionName: string) {
  return (value: string, previous: string[]): string[] => {
    const trimmed = value.trim();
    if (!trimmed) {
      throw new Error(`${optionName} cannot be empty`);
    }
    return [...previous, trimmed];
  };
}

async function resolveIssueLabelIds(
  ctx: CommandContext,
  opts: Pick<IssueCreateOptions, "label" | "labelId" | "parentId">,
): Promise<string[]> {
  const explicitIds = opts.labelId ?? [];
  const names = opts.label ?? [];
  if (names.length === 0 && explicitIds.length > 0) return [...new Set(explicitIds)];

  if (names.length === 0 && opts.parentId) return [];

  const labels = (await ctx.api.get<IssueLabel[]>(`/api/orgs/${ctx.orgId}/labels`)) ?? [];
  if (names.length === 0) {
    if (ctx.agentId && labels.length >= 5) {
      throw new Error(
        `Organization has ${labels.length} issue labels. Choose at least one with --label-id <id> or --label <name>. Available labels: ${formatAvailableLabelNames(labels)}`,
      );
    }
    return [];
  }

  const resolvedIds = names.map((name) => {
    const exact = labels.find((label) => label.name === name)
      ?? labels.find((label) => label.name.toLowerCase() === name.toLowerCase());
    if (!exact) {
      throw new Error(`Unknown issue label "${name}". Available labels: ${formatAvailableLabelNames(labels)}`);
    }
    return exact.id;
  });

  return [...new Set([...explicitIds, ...resolvedIds])];
}

function formatAvailableLabelNames(labels: IssueLabel[]): string {
  return labels.map((label) => label.name).join(", ") || "(none)";
}

async function appendUploadedIssueImages(
  ctx: CommandContext,
  issueId: string,
  body: string | undefined,
  imagePaths: string[] | undefined,
): Promise<string | undefined> {
  const paths = imagePaths ?? [];
  if (paths.length === 0) return body;

  const issue = await ctx.api.get<Issue>(`/api/issues/${issueId}`);
  if (!issue) {
    throw new Error("Issue not found");
  }

  const links: string[] = [];
  for (const imagePath of paths) {
    const attachment = await uploadIssueCommentImage(ctx, issue, imagePath);
    links.push(formatAttachmentMarkdown(attachment));
  }

  const base = body?.trimEnd() ?? "";
  const imageBlock = links.join("\n");
  return base ? `${base}\n\n${imageBlock}` : imageBlock;
}

async function uploadIssueCommentImage(
  ctx: CommandContext,
  issue: Issue,
  imagePath: string,
): Promise<IssueAttachment> {
  const resolvedPath = path.resolve(process.cwd(), imagePath);
  const stats = await stat(resolvedPath).catch((err: unknown) => {
    throw new Error(`Unable to read image ${imagePath}: ${err instanceof Error ? err.message : String(err)}`);
  });
  if (!stats.isFile()) {
    throw new Error(`Image path must be a file: ${imagePath}`);
  }

  const filename = path.basename(resolvedPath);
  const contentType = inferCommentImageContentType(filename);
  const buffer = await readFile(resolvedPath);
  if (buffer.length <= 0) {
    throw new Error(`Image is empty: ${imagePath}`);
  }

  const form = new FormData();
  form.set("usage", "comment_inline");
  form.set("file", new Blob([buffer], { type: contentType }), filename);

  const attachment = await ctx.api.postForm<IssueAttachment>(
    `/api/orgs/${issue.orgId}/issues/${issue.id}/attachments`,
    form,
  );
  if (!attachment) {
    throw new Error(`Image upload returned no attachment: ${imagePath}`);
  }
  return attachment;
}

function inferCommentImageContentType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      throw new Error(`Unsupported comment image type: ${filename}. Use PNG, JPEG, WebP, or GIF.`);
  }
}

function formatAttachmentMarkdown(attachment: IssueAttachment): string {
  const alt = escapeMarkdownAltText(attachment.originalFilename ?? "image");
  return `![${alt}](${attachment.contentPath})`;
}

function escapeMarkdownAltText(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("]", "\\]");
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

function parseReviewDecision(value: string): IssueReviewOptions["decision"] {
  const normalized = value.trim();
  if (
    normalized === "approve" ||
    normalized === "request_changes" ||
    normalized === "needs_followup" ||
    normalized === "blocked"
  ) {
    return normalized;
  }
  throw new Error("Invalid review decision. Use approve, request_changes, needs_followup, or blocked.");
}

function isIssueCommentResponse(value: IssueComment | null): value is IssueComment {
  return Boolean(
    value &&
      typeof value.id === "string" &&
      value.id.trim().length > 0 &&
      typeof value.issueId === "string" &&
      value.issueId.trim().length > 0 &&
      typeof value.body === "string",
  );
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

function buildIssueListPath(orgId: string, opts: IssueSearchOptions, searchQuery?: string): string {
  const params = new URLSearchParams();
  if (opts.status) params.set("status", opts.status);
  if (opts.assigneeAgentId) params.set("assigneeAgentId", opts.assigneeAgentId);
  if (opts.projectId) params.set("projectId", opts.projectId);
  if (searchQuery?.trim()) params.set("q", searchQuery.trim());

  const query = params.toString();
  return `/api/orgs/${orgId}/issues${query ? `?${query}` : ""}`;
}

function printIssueRows(rows: Issue[], json: boolean): void {
  if (json) {
    printOutput(rows, { json: true });
    return;
  }

  if (rows.length === 0) {
    printOutput([], { json: false });
    return;
  }

  for (const item of rows) {
    console.log(
      formatInlineRecord({
        identifier: item.identifier,
        id: item.id,
        status: item.status,
        priority: item.priority,
        assigneeAgentId: item.assigneeAgentId,
        assigneeUserId: item.assigneeUserId,
        title: item.title,
        projectId: item.projectId,
        updatedAt: item.updatedAt,
        ...(item.searchMatch ? { match: formatIssueSearchMatch(item.searchMatch) } : {}),
      }),
    );
  }
}

function formatIssueSearchMatch(match: NonNullable<Issue["searchMatch"]>): string {
  const commentSuffix = match.commentId ? `#${match.commentId}` : "";
  return `${match.field}${commentSuffix}: ${match.snippet}`;
}
