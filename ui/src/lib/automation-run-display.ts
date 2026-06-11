import type { AutomationRunSummary } from "@rudderhq/shared";
import type { InstanceLocale } from "@rudderhq/shared";

type AutomationRunDisplayInput = Pick<
  AutomationRunSummary,
  | "source"
  | "status"
  | "triggerId"
  | "trigger"
  | "triggerPayload"
  | "linkedIssue"
  | "linkedChatConversation"
  | "coalescedIntoRunId"
  | "failureReason"
>;

export type AutomationRunDisplay = {
  sourceLabel: string;
  statusLabel: string;
  statusClassName: string;
  context: string | null;
  destinationLabel: string | null;
  title: string;
};

const statusLabels: Record<string, { en: string; "zh-CN": string }> = {
  received: { en: "Queued", "zh-CN": "已排队" },
  running: { en: "Running", "zh-CN": "运行中" },
  issue_created: { en: "Opened issue", "zh-CN": "已创建任务" },
  completed: { en: "Completed", "zh-CN": "已完成" },
  failed: { en: "Failed", "zh-CN": "失败" },
  coalesced: { en: "Coalesced", "zh-CN": "已合并" },
  skipped: { en: "Skipped", "zh-CN": "已跳过" },
};

const statusClassNames: Record<string, string> = {
  received: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300",
  running: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300",
  issue_created: "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  completed: "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  failed: "border-destructive/35 bg-destructive/10 text-destructive",
  coalesced: "border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  skipped: "border-muted-foreground/25 bg-muted/50 text-muted-foreground",
};

function humanizeToken(value: string): string {
  return value.replaceAll("_", " ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readPath(payload: Record<string, unknown> | null | undefined, path: string): unknown {
  if (!payload) return null;
  let current: unknown = payload;
  for (const key of path.split(".")) {
    if (!isRecord(current)) return null;
    current = current[key];
  }
  return current;
}

function readString(payload: Record<string, unknown> | null | undefined, paths: string[]): string | null {
  for (const path of paths) {
    const value = readPath(payload, path);
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}...`;
}

function branchFromRef(value: string | null): string | null {
  if (!value) return null;
  return value.replace(/^refs\/heads\//u, "").replace(/^refs\/tags\//u, "tag:");
}

function shortSha(value: string | null): string | null {
  if (!value) return null;
  const match = value.match(/[a-f0-9]{7,40}/iu);
  return match ? match[0]!.slice(0, 7) : null;
}

function uniqueNonEmpty(parts: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const resolved: string[] = [];
  for (const part of parts) {
    const value = part?.trim();
    if (!value || seen.has(value.toLowerCase())) continue;
    seen.add(value.toLowerCase());
    resolved.push(value);
  }
  return resolved;
}

function isCiTriggerHint(value: string | null | undefined): boolean {
  if (!value) return false;
  return /\b(ci|cd|build|check|pipeline|workflow|github actions)\b/iu.test(value);
}

export function summarizeAutomationCiPayload(payload: Record<string, unknown> | null | undefined): string[] {
  const repo = readString(payload, [
    "repository.full_name",
    "repository.name",
    "project.path_with_namespace",
    "project.name",
    "repo.full_name",
    "repo.name",
  ]);
  const workflow = readString(payload, [
    "workflow_run.name",
    "workflow.name",
    "workflow_job.name",
    "check_run.name",
    "check_suite.app.name",
    "job.name",
    "pipeline.name",
    "object_attributes.name",
  ]);
  const action = readString(payload, ["action", "object_kind", "event_name", "event"]);
  const pr = readString(payload, ["pull_request.number", "merge_request.iid", "object_attributes.iid"]);
  const branch = branchFromRef(readString(payload, [
    "workflow_run.head_branch",
    "check_suite.head_branch",
    "pull_request.head.ref",
    "merge_request.source_branch",
    "object_attributes.ref",
    "ref_name",
    "ref",
    "branch",
  ]));
  const sha = shortSha(readString(payload, [
    "workflow_run.head_sha",
    "check_suite.head_sha",
    "check_run.head_sha",
    "head_commit.id",
    "after",
    "commit.id",
    "sha",
  ]));
  const prLabel = pr ? `PR #${pr}` : null;

  return uniqueNonEmpty([
    repo ? truncate(repo, 40) : null,
    workflow ? truncate(workflow, 32) : null,
    prLabel,
    branch ? truncate(branch, 28) : null,
    sha,
    action && !["push", "pull_request", "workflow_run", "pipeline"].includes(action) ? truncate(action, 24) : null,
  ]).slice(0, 5);
}

function sourceLabel(run: AutomationRunDisplayInput, contextParts: string[], locale: InstanceLocale): string {
  const triggerLabel = run.trigger?.label?.trim() ?? null;
  if (run.source === "manual") return locale === "zh-CN" ? "手动运行" : "Manual run";
  if (run.source === "api") return locale === "zh-CN" ? "API 运行" : "API run";
  if (run.source === "schedule") return triggerLabel ? (locale === "zh-CN" ? `日程：${triggerLabel}` : `Schedule: ${triggerLabel}`) : (locale === "zh-CN" ? "计划运行" : "Scheduled run");
  if (run.source === "webhook") {
    if (isCiTriggerHint(triggerLabel) || contextParts.length > 0) return locale === "zh-CN" ? "CI webhook" : "CI webhook";
    return triggerLabel ? (locale === "zh-CN" ? `Webhook：${triggerLabel}` : `Webhook: ${triggerLabel}`) : (locale === "zh-CN" ? "Webhook 运行" : "Webhook run");
  }
  return humanizeToken(run.source);
}

function destinationLabel(run: AutomationRunDisplayInput, locale: InstanceLocale): string | null {
  if (run.linkedIssue) {
    return `${locale === "zh-CN" ? "任务" : "Issue"} ${run.linkedIssue.identifier ?? run.linkedIssue.title}`;
  }
  if (run.linkedChatConversation) {
    return `${locale === "zh-CN" ? "聊天" : "Chat"} ${run.linkedChatConversation.title}`;
  }
  if (run.coalescedIntoRunId) {
    return `${locale === "zh-CN" ? "已有运行" : "Existing run"} ${run.coalescedIntoRunId.slice(0, 8)}`;
  }
  if (run.failureReason) {
    return truncate(run.failureReason, 96);
  }
  return null;
}

export function getAutomationRunDisplay(run: AutomationRunDisplayInput, locale: InstanceLocale = "en"): AutomationRunDisplay {
  const payloadContext = summarizeAutomationCiPayload(run.triggerPayload);
  const triggerLabel = run.trigger?.label?.trim() ?? null;
  const context = uniqueNonEmpty([
    ...payloadContext,
    run.triggerId && !run.trigger ? (locale === "zh-CN" ? "触发器已移除" : "Trigger removed") : null,
  ]).join(" · ");
  const resolvedStatusLabel = statusLabels[run.status]?.[locale] ?? humanizeToken(run.status);
  const resolvedSourceLabel = sourceLabel(run, payloadContext, locale);
  const resolvedDestination = destinationLabel(run, locale);
  const title = uniqueNonEmpty([
    resolvedStatusLabel,
    resolvedSourceLabel,
    context,
    resolvedDestination,
  ]).join(" · ");

  return {
    sourceLabel: resolvedSourceLabel,
    statusLabel: resolvedStatusLabel,
    statusClassName: statusClassNames[run.status] ?? "border-border bg-muted/40 text-muted-foreground",
    context: context || null,
    destinationLabel: resolvedDestination,
    title,
  };
}
