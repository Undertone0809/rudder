import {
  createApprovalSchema,
  requestApprovalRevisionSchema,
  resolveApprovalSchema,
  resubmitApprovalSchema,
  type Approval,
  type ApprovalComment,
  type Issue,
} from "@rudderhq/shared";
import { Command } from "commander";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getAgentCliCapabilityById } from "../../agent-v1-registry.js";
import {
  addCommonClientOptions,
  formatInlineRecord,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";
import { formatExamplesAndCautions } from "./help.js";

interface ApprovalListOptions extends BaseClientOptions {
  orgId?: string;
  status?: string;
}

interface ApprovalDecisionOptions extends BaseClientOptions {
  decisionNote?: string;
  decidedByUserId?: string;
}

interface ApprovalCreateOptions extends BaseClientOptions {
  orgId?: string;
  type: string;
  requestedByAgentId?: string;
  payload: string;
  issueIds?: string;
}

interface ApprovalResubmitOptions extends BaseClientOptions {
  payload?: string;
}

interface ApprovalCommentOptions extends BaseClientOptions {
  bodyFile: string;
}

export function registerApprovalCommands(program: Command): void {
  const approval = program.command("approval").description("Approval operations");

  addCommonClientOptions(
    approval
      .command("list")
      .description("List approvals for an organization")
      .option("-O, --org-id <id>", "Organization ID")
      .option("--status <status>", "Status filter")
      .action(async (opts: ApprovalListOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const params = new URLSearchParams();
          if (opts.status) params.set("status", opts.status);
          const query = params.toString();
          const rows =
            (await ctx.api.get<Approval[]>(`/api/orgs/${ctx.orgId}/approvals${query ? `?${query}` : ""}`)) ?? [];

          if (ctx.json) {
            printOutput(rows, { json: true });
            return;
          }

          if (rows.length === 0) {
            printOutput([], { json: false });
            return;
          }

          for (const row of rows) {
            console.log(
              formatInlineRecord({
                id: row.id,
                type: row.type,
                status: row.status,
                requestedByAgentId: row.requestedByAgentId,
                requestedByUserId: row.requestedByUserId,
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
    approval
      .command("get")
      .description(getAgentCliCapabilityById("approval.get").description)
      .argument("<approvalId>", "Approval ID")
      .action(async (approvalId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<Approval>(`/api/approvals/${approvalId}`);
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    approval
      .command("issues")
      .description(getAgentCliCapabilityById("approval.issues").description)
      .argument("<approvalId>", "Approval ID")
      .action(async (approvalId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const rows = (await ctx.api.get<Issue[]>(`/api/approvals/${approvalId}/issues`)) ?? [];
          printOutput(rows, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    approval
      .command("create")
      .description(getAgentCliCapabilityById("approval.create").description)
      .option("-O, --org-id <id>", "Organization ID")
      .requiredOption("--type <type>", "Approval type (hire_agent|approve_ceo_strategy)")
      .requiredOption("--payload <json>", "Approval payload as JSON object")
      .option("--requested-by-agent-id <id>", "Requesting agent ID")
      .option("--issue-ids <csv>", "Comma-separated linked issue IDs")
      .action(async (opts: ApprovalCreateOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const payloadJson = parseJsonObject(opts.payload, "payload");
          const payload = createApprovalSchema.parse({
            type: opts.type,
            payload: payloadJson,
            requestedByAgentId: opts.requestedByAgentId,
            issueIds: parseCsv(opts.issueIds),
          });
          const created = await ctx.api.post<Approval>(`/api/orgs/${ctx.orgId}/approvals`, payload);
          printOutput(created, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    approval
      .command("approve")
      .description("Approve an approval request")
      .argument("<approvalId>", "Approval ID")
      .option("--decision-note <text>", "Decision note")
      .option("--decided-by-user-id <id>", "Decision actor user ID")
      .addHelpText("after", formatExamplesAndCautions({
        examples: [
          {
            description: "Read the approval payload before deciding:",
            command: "rudder approval get <approval-id> --json",
          },
          {
            description: "Record the durable approval decision with concise context:",
            command: "rudder approval approve <approval-id> --decision-note \"Approved after reviewing linked issues\" --json",
          },
        ],
        cautions: [
          "Read the approval and linked issues before approving; this is a governed mutation.",
          "approval approve/reject use --decision-note, while approval comment uses --body-file.",
        ],
      }))
      .action(async (approvalId: string, opts: ApprovalDecisionOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = resolveApprovalSchema.parse({
            decisionNote: opts.decisionNote,
            decidedByUserId: opts.decidedByUserId,
          });
          const updated = await ctx.api.post<Approval>(`/api/approvals/${approvalId}/approve`, payload);
          printOutput(updated, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    approval
      .command("reject")
      .description("Reject an approval request")
      .argument("<approvalId>", "Approval ID")
      .option("--decision-note <text>", "Decision note")
      .option("--decided-by-user-id <id>", "Decision actor user ID")
      .action(async (approvalId: string, opts: ApprovalDecisionOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = resolveApprovalSchema.parse({
            decisionNote: opts.decisionNote,
            decidedByUserId: opts.decidedByUserId,
          });
          const updated = await ctx.api.post<Approval>(`/api/approvals/${approvalId}/reject`, payload);
          printOutput(updated, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    approval
      .command("request-revision")
      .description("Request revision for an approval")
      .argument("<approvalId>", "Approval ID")
      .option("--decision-note <text>", "Decision note")
      .option("--decided-by-user-id <id>", "Decision actor user ID")
      .action(async (approvalId: string, opts: ApprovalDecisionOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = requestApprovalRevisionSchema.parse({
            decisionNote: opts.decisionNote,
            decidedByUserId: opts.decidedByUserId,
          });
          const updated = await ctx.api.post<Approval>(`/api/approvals/${approvalId}/request-revision`, payload);
          printOutput(updated, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    approval
      .command("resubmit")
      .description(getAgentCliCapabilityById("approval.resubmit").description)
      .argument("<approvalId>", "Approval ID")
      .option("--payload <json>", "Payload JSON object")
      .action(async (approvalId: string, opts: ApprovalResubmitOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = resubmitApprovalSchema.parse({
            payload: opts.payload ? parseJsonObject(opts.payload, "payload") : undefined,
          });
          const updated = await ctx.api.post<Approval>(`/api/approvals/${approvalId}/resubmit`, payload);
          printOutput(updated, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    approval
      .command("comment")
      .description(getAgentCliCapabilityById("approval.comment").description)
      .argument("<approvalId>", "Approval ID")
      .option("--body-file <path>", "Read comment body from a file, or '-' for stdin")
      .addHelpText("after", formatExamplesAndCautions({
        examples: [
          {
            description: "Add a longer Markdown discussion note without deciding:",
            command: "rudder approval comment <approval-id> --body-file ./approval-note.md --json",
          },
          {
            description: "Ask a short follow-up from stdin:",
            command: "printf '%s\\n' 'Need one more linked issue checked.' | rudder approval comment <approval-id> --body-file -",
          },
        ],
        cautions: [
          "Comments do not approve or reject; use approve/reject/request-revision for the durable decision.",
          "Use --body-file for multiline Markdown. Do not pass decision notes here.",
        ],
      }))
      .action(async (approvalId: string, opts: ApprovalCommentOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const body = await resolveBodyFile(opts.bodyFile);
          const created = await ctx.api.post<ApprovalComment>(`/api/approvals/${approvalId}/comments`, {
            body,
          });
          printOutput(created, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

async function resolveBodyFile(inputPath: string | undefined): Promise<string> {
  if (!inputPath) {
    throw new Error("Provide --body-file <path>; use --body-file - for stdin");
  }
  return readTextInputFile(inputPath, "--body-file");
}

async function readTextInputFile(inputPath: string, optionName: string): Promise<string> {
  if (inputPath === "-") {
    return readStdinText();
  }
  const resolvedPath = path.resolve(process.cwd(), inputPath);
  return readFile(resolvedPath, "utf8").catch((err: unknown) => {
    throw new Error(`Unable to read ${optionName} ${inputPath}: ${err instanceof Error ? err.message : String(err)}`);
  });
}

async function readStdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseCsv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const rows = value.split(",").map((v) => v.trim()).filter(Boolean);
  return rows.length > 0 ? rows : undefined;
}

function parseJsonObject(value: string, name: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${name} must be a JSON object`);
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    throw new Error(`Invalid ${name} JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}
