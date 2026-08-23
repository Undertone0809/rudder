import { Button } from "@/components/ui/button";
import { Link } from "@/lib/router";
import {
  parseLibraryEntryMentionHref,
  parseLibraryFileMentionHref,
  type GoalActivityTimelinePage,
  type GoalFeedbackAttachment,
  type GoalWorkspaceFacet,
  type Issue,
  type Project,
} from "@rudderhq/shared";
import {
  ArrowRight,
  CircleDot,
  ExternalLink,
  Paperclip,
} from "lucide-react";
import type { ReactNode, Ref } from "react";
import type { SidePanelTarget } from "@/lib/side-panel-targets";
import { CommentThreadActivityRow, type CommentThreadActivityItem } from "../components/CommentThread";
import type { LinkedRunItem } from "../components/CommentThread.runs";
import { MarkdownBody } from "../components/MarkdownBody";
import { cn, issueUrl, projectUrl } from "../lib/utils";

type ChangeProposalView = {
  id: string;
  status: string;
  before: string;
  after: string;
  rationale: string | null;
  impact: string | null;
  evidenceRefs: string[];
  evidence: EvidenceItem[];
};

type ResultProposalView = {
  id: string;
  status: string;
  outcome: string;
  outcomeKind: string;
  risks: string | null;
  criteria: Array<{
    label: string;
    status: "met" | "unmet" | "breached" | "unknown";
    statusLabel: string;
  }>;
  evidenceCheck: string;
  evidence: EvidenceItem[];
  gaps: string[];
};

type EvidenceItem = {
  label: string;
  href: string | null;
  external: boolean;
};

type EvidenceContext = {
  issues: Issue[];
  projects: Project[];
  runAgentId: string | null;
};

type PendingFeedback = {
  identity: string;
  idempotencyKey: string;
  body: string;
  attachments: GoalFeedbackAttachment[];
  createdAt: string;
  feedbackKind: "ordinary" | "consequential";
  status: "sending" | "failed";
  error: string | null;
};

type ResultDecisionInput = {
  goalId: string;
  id: string;
  decision: "accept" | "reject";
  feedback?: string;
  idempotencyKey: string;
};

type DecisionFocusRequest = {
  goalId: string;
  kind: "change" | "result";
  id: string;
};

type ChangeDecisionInput = {
  goalId: string;
  id: string;
  decision: "approve" | "reject";
};

const goalStatusIconStatus: Record<string, string> = {
  planned: "todo",
  active: "in_progress",
  achieved: "done",
  cancelled: "cancelled",
};

function goalStatusLabel(status: string) {
  return status.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

const GOAL_DETAIL_TABS = ["overview", "activity"] as const;
type GoalDetailTab = (typeof GOAL_DETAIL_TABS)[number];
type GoalTimelineItem = GoalActivityTimelinePage["items"][number];

function goalTimelineItemKey(entry: GoalTimelineItem) {
  return entry.source === "goal-history"
    ? `${entry.source}:${entry.item.kind}:${entry.item.id}`
    : `${entry.source}:${entry.item.id}`;
}

function mergeGoalTimelineItems(current: GoalTimelineItem[], incoming: GoalTimelineItem[]) {
  const merged = new Map<string, GoalTimelineItem>();
  for (const entry of current) merged.set(goalTimelineItemKey(entry), entry);
  // The first page is polled. Let fresh rows replace their previous snapshot
  // while keeping older pages and their ordering in the accumulated list.
  for (const entry of incoming) merged.set(goalTimelineItemKey(entry), entry);
  return [...merged.values()];
}

function goalDetailTab(search: string): GoalDetailTab {
  const value = new URLSearchParams(search).get("tab");
  if (value === "activity") return "activity";
  return "overview";
}

function storedGoalChatTarget(
  organizationId: string,
  goalId: string,
): Extract<SidePanelTarget, { kind: "goal_chat" }> | null {
  try {
    const value = JSON.parse(window.localStorage.getItem(`rudder.goal-chat:${organizationId}:${goalId}`) ?? "null") as unknown;
    const record = asRecord(value);
    if (
      record.kind !== "goal_chat"
      || record.organizationId !== organizationId
      || record.goalId !== goalId
      || typeof record.clientMutationId !== "string"
    ) return null;
    return {
      kind: "goal_chat",
      organizationId,
      goalId,
      agentId: typeof record.agentId === "string" ? record.agentId : null,
      conversationId: typeof record.conversationId === "string" ? record.conversationId : null,
      clientMutationId: record.clientMutationId,
      body: typeof record.body === "string" ? record.body : "",
      label: typeof record.label === "string" ? record.label : "Goal",
    };
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readString(record: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function readStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : [];
}

function normalizeEvidenceItems(value: unknown): EvidenceItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    const label = readString(record, "label");
    if (!label) return [];
    return [{
      label,
      href: typeof record.href === "string" && record.href.startsWith("/") ? record.href : null,
      external: record.external === true,
    }];
  });
}

const criterionStatusLabels = {
  met: "Met",
  unmet: "Not met",
  breached: "Breached",
  unknown: "Not verified",
} as const;

function readCriterionStatus(value: unknown): keyof typeof criterionStatusLabels {
  return value === "met" || value === "unmet" || value === "breached" || value === "unknown"
    ? value
    : "unknown";
}

function parseEvidenceReference(reference: string) {
  try {
    const url = new URL(reference);
    const scheme = url.protocol.replace(/:$/, "").toLowerCase();
    const hasSimplePath = url.pathname === "" || url.pathname === "/";
    const entityId = !url.username
      && !url.password
      && !url.port
      && hasSimplePath
      && /^[a-z0-9][a-z0-9._-]*$/i.test(url.hostname)
      ? url.hostname
      : null;
    return { scheme, entityId, url };
  } catch {
    return { scheme: "", entityId: null, url: null };
  }
}

function evidenceType(reference: string) {
  const { scheme } = parseEvidenceReference(reference);
  if (scheme === "artifact") return "Artifact evidence";
  if (scheme === "run") return "Supporting work";
  if (scheme === "issue") return "Issue evidence";
  if (scheme === "project") return "Project evidence";
  if (scheme === "approval") return "Approval evidence";
  if (scheme === "decision") return "Decision evidence";
  if (scheme === "file") return "File evidence";
  if (scheme === "measurement") return "Measurement evidence";
  if (scheme === "library-file") return "Library file evidence";
  if (scheme === "library-entry") return "Library entry evidence";
  if (scheme === "http" || scheme === "https") return "External link evidence";
  return "Other evidence";
}

function publicLibraryName(path: string) {
  const name = path.split("/").filter(Boolean).at(-1);
  return name && !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(name) ? name : null;
}

function evidenceItems(refs: string[], context: EvidenceContext): EvidenceItem[] {
  return refs.map((reference, index) => {
    const libraryFile = parseLibraryFileMentionHref(reference);
    if (libraryFile) {
      const search = new URLSearchParams({ path: libraryFile.filePath });
      const publicName = publicLibraryName(libraryFile.filePath);
      return {
        label: publicName ? `Library file: ${publicName}` : "Library file evidence",
        href: `/library?${search.toString()}`,
        external: false,
      };
    }
    const libraryEntry = parseLibraryEntryMentionHref(reference);
    if (libraryEntry) {
      const search = new URLSearchParams({ entry: libraryEntry.entryId });
      if (libraryEntry.path) search.set("path", libraryEntry.path);
      const publicName = libraryEntry.path ? publicLibraryName(libraryEntry.path) : null;
      return {
        label: publicName
          ? `Library entry: ${publicName}`
          : `Library entry evidence ${index + 1}`,
        href: `/library?${search.toString()}`,
        external: false,
      };
    }
    const { scheme, entityId, url } = parseEvidenceReference(reference);
    if (scheme === "issue" && entityId) {
      const issue = context.issues.find((candidate) => candidate.id === entityId);
      return {
        label: issue
          ? `Issue ${issue.identifier ? `${issue.identifier}: ` : ""}${issue.title}`
          : `Issue evidence ${index + 1}`,
        href: issueUrl(issue ?? { id: entityId }),
        external: false,
      };
    }
    if (scheme === "project" && entityId) {
      const project = context.projects.find((candidate) => candidate.id === entityId);
      return {
        label: project ? `Project: ${project.name}` : `Project evidence ${index + 1}`,
        href: projectUrl(project ?? { id: entityId }),
        external: false,
      };
    }
    if (scheme === "approval" && entityId) {
      return {
        label: `Approval evidence ${index + 1}`,
        href: `/messenger/approvals/${encodeURIComponent(entityId)}`,
        external: false,
      };
    }
    if (scheme === "run" && entityId && context.runAgentId) {
      return {
        label: `Supporting work ${index + 1}`,
        href: `/agents/${encodeURIComponent(context.runAgentId)}/runs/${encodeURIComponent(entityId)}`,
        external: false,
      };
    }
    if (scheme === "https" && url && !url.username && !url.password) {
      return {
        label: `External link evidence ${index + 1}`,
        href: url.href,
        external: true,
      };
    }
    return { label: `${evidenceType(reference)} ${index + 1}`, href: null, external: false };
  });
}

function outcomeLabel(outcome: string, preflight: Record<string, unknown>, candidate: Record<string, unknown>) {
  const resultValue = preflight.resultValue ?? candidate.resultValue;
  const decision = readString(preflight, "decision") ?? readString(candidate, "decision");
  if (outcome === "achieved") return "Goal achieved";
  if (outcome === "not_achieved") return "Goal not achieved";
  if (outcome === "maintained") return "Goal maintained";
  if (outcome === "breached") return "Goal condition breached";
  if (outcome === "completed_with_result") {
    return typeof resultValue === "string" || typeof resultValue === "number" || typeof resultValue === "boolean"
      ? `Completed with result: ${String(resultValue)}`
      : "Completed with a measured result";
  }
  if (outcome === "decided") return decision ? `Decision reached: ${decision}` : "Decision reached";
  return "Result is not conclusive yet";
}

function evidenceCheck(outcome: string, criteria: Array<{ status: keyof typeof criterionStatusLabels }>) {
  const unknownCount = criteria.filter((criterion) => criterion.status === "unknown").length;
  const unknownSuffix = unknownCount > 0
    ? ` ${unknownCount} ${unknownCount === 1 ? "criterion remains" : "criteria remain"} unverified.`
    : "";
  if (outcome === "achieved") return "The submitted evidence supports every success criterion.";
  if (outcome === "not_achieved") return `The submitted evidence supports closing this Goal as not achieved.${unknownSuffix}`;
  if (outcome === "maintained") return "The submitted evidence supports every condition that must remain true.";
  if (outcome === "breached") return `The submitted evidence confirms that a required condition was breached.${unknownSuffix}`;
  if (outcome === "completed_with_result") return "The submitted evidence supports closing this Goal with the recorded result.";
  if (outcome === "decided") return "The submitted evidence supports closing this Goal with the recorded decision.";
  return `The result cannot be verified yet.${unknownSuffix}`;
}

function summarizeValue(value: unknown) {
  if (typeof value === "string" && value.trim()) return value;
  const record = asRecord(value);
  const direct = readString(record, "summary", "outcomeStatement", "outcome", "title");
  const labels = Array.isArray(record.criteria)
    ? record.criteria.flatMap((criterion) => {
      const label = readString(asRecord(criterion), "label", "summary", "outcome");
      return label ? [label] : [];
    })
    : [];
  const target = readString(record, "evaluationDeadline", "actionDeadline", "targetTime");
  const boundary = readString(record, "boundarySummary") ?? publicBoundarySummary(record.autonomyEnvelope);
  const approval = readString(record, "approvalSummary") ?? publicApprovalSummary(record.humanAuthorities);
  const completion = readString(record, "completionSummary") ?? publicCompletionSummary(record.evaluationPolicy);
  const boundaryParts = [
    boundary ? `Scope: ${boundary}` : null,
    approval ? `Your call: ${approval}` : null,
    completion ? `Ready when: ${completion}` : null,
  ];
  const parts = [
    direct ? `Outcome: ${direct}` : null,
    labels.length > 0 ? `Success: ${labels.join("; ")}` : null,
    target ? `Target date: ${target}` : null,
    ...boundaryParts,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join("\n") : Object.keys(record).length === 0 ? "Not provided" : "The Goal direction would change.";
}

function publicToken(value: string) {
  const known: Record<string, string> = {
    bounded_reversible_work: "bounded, reversible work",
    external_or_irreversible_action: "external or irreversible actions",
    external_publication: "publishing externally",
    authority_expansion: "expanding access",
    acceptance: "accepting the result",
    consequentialChanges: "consequential changes",
    externalPublication: "publishing externally",
  };
  return known[value] ?? value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase();
}

function publicBoundarySummary(value: unknown) {
  const record = asRecord(value);
  const allowed = readStringArray(record.allowed).map(publicToken);
  const approvals = readStringArray(record.requiresHumanApproval).map(publicToken);
  const parts = [
    allowed.length > 0 ? `The Agent may handle ${allowed.join(", ")}.` : null,
    approvals.length > 0 ? `You will be asked before ${approvals.join(", ")}.` : null,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" ") : null;
}

function publicApprovalSummary(value: unknown) {
  const decisions = Object.entries(asRecord(value))
    .filter(([, entry]) => entry === "board_human" || entry === true)
    .map(([key]) => publicToken(key));
  return decisions.length > 0 ? `You decide ${decisions.join(", ")}.` : null;
}

function publicCompletionSummary(value: unknown) {
  const record = asRecord(value);
  const requiresEvidence = record.terminalEvidenceRequired === true;
  const requiresAcceptance = record.humanAcceptanceRequired === true;
  if (requiresEvidence && requiresAcceptance) return "Supporting work is shown, and you accept the result.";
  if (requiresEvidence) return "Supporting work is shown before the result is considered ready.";
  if (requiresAcceptance) return "You accept the result when it is ready.";
  return null;
}

function publicProposalText(value: string | null) {
  if (!value) return value;
  return value
    .replace(/\bgoal\s+contract\b/gi, "Goal")
    .replace(/\bcontract\s+revision\b/gi, "Goal update")
    .replace(/\bcontracts?\b/gi, "agreement")
    .replace(/\bobjective\s+mode\b/gi, "Goal type")
    .replace(/\bevaluator\b/gi, "success check")
    .replace(/\bevidence\s+requirements?\b/gi, "what we need to verify")
    .replace(/\bautonomy\s+envelope\b/gi, "working scope")
    .replace(/\bhuman\s+authorit(?:y|ies)\b/gi, "decisions you make")
    .replace(/\b(?:evidence|artifact|run)\s+uri\b/gi, "supporting work")
    .replace(/\b(?:artifact|run|issue|project|approval|decision|measurement|library-file|library-entry):\/\/[^\s)]+/gi, "supporting work")
    .replace(/\b(?:goal-feedback|goal-start|goal-change-decision|goal-result-evaluation):[0-9a-f-]{8,}\b/gi, "the related update")
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "the related item");
}

function contractChangeImpact(before: Record<string, unknown>, after: Record<string, unknown>) {
  const impacts = [
    Object.hasOwn(after, "outcomeStatement") && after.outcomeStatement !== before.outcomeStatement
      ? "the result the Agent is working toward"
      : null,
    (Object.hasOwn(after, "criteria") && JSON.stringify(before.criteria) !== JSON.stringify(after.criteria))
      || (Object.hasOwn(after, "objectiveMode") && before.objectiveMode !== after.objectiveMode)
      ? "how success is judged"
      : null,
    Object.hasOwn(after, "autonomyEnvelope") && JSON.stringify(before.autonomyEnvelope) !== JSON.stringify(after.autonomyEnvelope)
      ? "what the Agent can do independently"
      : null,
    Object.hasOwn(after, "humanAuthorities") && JSON.stringify(before.humanAuthorities) !== JSON.stringify(after.humanAuthorities)
      ? "which decisions need your approval"
      : null,
    Object.hasOwn(after, "evaluationPolicy") && JSON.stringify(before.evaluationPolicy) !== JSON.stringify(after.evaluationPolicy)
      ? "what evidence is needed before acceptance"
      : null,
    (Object.hasOwn(after, "actionDeadline") && before.actionDeadline !== after.actionDeadline)
      || (Object.hasOwn(after, "evaluationDeadline") && before.evaluationDeadline !== after.evaluationDeadline)
      ? "when the work or review is expected"
      : null,
  ].filter((value): value is string => Boolean(value));
  return impacts.length > 0
    ? `This may require the Agent to replan around ${impacts.join(", ")}.`
    : "No user-visible impact was found in the proposed Goal update.";
}

function normalizeChangeProposals(value: unknown): ChangeProposalView[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    const id = readString(record, "id");
    if (!id) return [];
    const beforeValue = record.beforeSummary ?? record.before ?? record.beforeSnapshot ?? record.beforeContract;
    const afterValue = record.afterSummary ?? record.after ?? record.afterContract ?? record.afterPatch;
    const afterRecord = asRecord(afterValue);
    const beforeRecord = asRecord(beforeValue);
    const matchingBefore = Object.keys(afterRecord).length > 0
      ? Object.fromEntries(Object.keys(afterRecord).map((key) => [key, beforeRecord[key]]))
      : beforeValue;
    return [{
      id,
      status: readString(record, "status") ?? "pending",
      before: summarizeValue(matchingBefore),
      after: summarizeValue(afterValue),
      rationale: publicProposalText(readString(record, "rationale", "reason")),
      impact: publicProposalText(readString(record, "impact", "impactSummary") ?? contractChangeImpact(beforeRecord, afterRecord)),
      evidenceRefs: readStringArray(record.evidenceRefs),
      evidence: normalizeEvidenceItems(record.evidence),
    }];
  });
}

function normalizeResultProposals(
  value: unknown,
  goalCriteria: unknown,
  context: { issues: Issue[]; projects: Project[]; ownerAgentId: string | null },
): ResultProposalView[] {
  if (!Array.isArray(value)) return [];
  const criterionLabels = new Map(
    (Array.isArray(goalCriteria) ? goalCriteria : []).flatMap((criterion) => {
      const record = asRecord(criterion);
      const id = readString(record, "id");
      const label = readString(record, "label");
      return id && label ? [[id, label] as const] : [];
    }),
  );
  return value.flatMap((item) => {
    const record = asRecord(item);
    const id = readString(record, "id");
    if (!id) return [];
    const preflight = asRecord(record.preflight);
    const candidate = asRecord(record.candidate);
    const rawCriteria = Array.isArray(record.criteria) ? record.criteria : preflight.criteria;
    const criteria = (Array.isArray(rawCriteria) ? rawCriteria : []).map((criterion, index) => {
      const criterionRecord = asRecord(criterion);
      const criterionId = readString(criterionRecord, "id");
      const status = readCriterionStatus(criterionRecord.status);
      const missingEvidence = readStringArray(criterionRecord.missingEvidence);
      const missingEvidenceCount = typeof criterionRecord.missingEvidenceCount === "number"
        ? criterionRecord.missingEvidenceCount
        : missingEvidence.length;
      return {
        label: criterionId ? criterionLabels.get(criterionId) ?? `Success criterion ${index + 1}` : `Success criterion ${index + 1}`,
        status,
        statusLabel: criterionStatusLabels[status],
        // Legacy fixtures may still contain the reference scheme; the public
        // DTO only has a count, so use a neutral public label for that shape.
        missingEvidence: missingEvidenceCount > 0
          ? missingEvidence.length > 0
            ? missingEvidence
            : Array.from({ length: missingEvidenceCount }, () => "supporting work")
          : [],
      };
    });
    const gaps = criteria.flatMap((criterion) => {
      const missingTypes = Array.from(new Set(criterion.missingEvidence.map((reference) => evidenceType(reference).toLowerCase())));
      if (missingTypes.length > 0) {
        return [`${criterion.label} still needs ${missingTypes.join(" and ")}.`];
      }
      return criterion.status === "unknown" ? [`${criterion.label} is not verified.`] : [];
    });
    const outcomeKind = readString(record, "outcome") ?? readString(preflight, "outcome") ?? "inconclusive";
    const evidenceRefs = readStringArray(record.evidenceRefs).length > 0
      ? readStringArray(record.evidenceRefs)
      : readStringArray(candidate.evidenceRefs).length > 0
      ? readStringArray(candidate.evidenceRefs)
      : readStringArray(preflight.evidenceRefs);
    const publicCriteria = criteria.map(({ label, status, statusLabel }) => ({ label, status, statusLabel }));
    const publicEvidence = normalizeEvidenceItems(record.evidence);
    return [{
      id,
      status: readString(record, "status") ?? "ready",
      outcome: readString(record, "outcomeLabel") ?? outcomeLabel(outcomeKind, preflight, candidate),
      outcomeKind,
      risks: readString(record, "riskSummary"),
      criteria: publicCriteria,
      evidenceCheck: evidenceCheck(outcomeKind, publicCriteria),
      evidence: publicEvidence.length > 0
        ? publicEvidence
        : evidenceItems(evidenceRefs, {
          issues: context.issues,
          projects: context.projects,
          runAgentId: readString(record, "proposedByAgentId") ?? context.ownerAgentId,
        }),
      gaps,
    }];
  });
}

function Section({
  title,
  icon: Icon,
  children,
  id,
  headingRef,
}: {
  title: string;
  icon: typeof CircleDot;
  children: ReactNode;
  id?: string;
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  return (
    <section id={id} className="min-w-0 space-y-3 border-t border-border pt-4">
      <h2 ref={headingRef} tabIndex={headingRef ? -1 : undefined} className="flex items-center gap-2 rounded-sm text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
        {title}
      </h2>
      {children}
    </section>
  );
}

function EvidenceItemsList({ items, ariaLabel }: { items: EvidenceItem[]; ariaLabel: string }) {
  if (items.length === 0) return null;
  return (
    <div aria-label={ariaLabel} className="mt-2 divide-y divide-border border-y border-border">
      {items.map((item, index) => {
        const content = (
          <>
            <span className="min-w-0 break-words">{item.label}</span>
            <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
              Open
              {item.external ? <ExternalLink className="h-3.5 w-3.5" /> : <ArrowRight className="h-3.5 w-3.5" />}
            </span>
          </>
        );
        if (item.external && item.href) {
          return (
            <a
              key={`${item.label}:${item.href}:${index}`}
              href={item.href}
              target="_blank"
              rel="noopener noreferrer"
              className="flex min-w-0 items-center justify-between gap-3 py-2 text-sm hover:bg-accent/35"
            >
              {content}
            </a>
          );
        }
        if (item.href) {
          return (
            <Link
              key={`${item.label}:${item.href}:${index}`}
              to={item.href}
              className="flex min-w-0 items-center justify-between gap-3 py-2 text-sm hover:bg-accent/35"
            >
              {content}
            </Link>
          );
        }
        return (
          <div key={`${item.label}:${index}`} className="flex min-w-0 items-center justify-between gap-3 py-2 text-sm">
            <span className="min-w-0 break-words">{item.label}</span>
            <span className="shrink-0 text-xs text-muted-foreground">Unavailable</span>
          </div>
        );
      })}
    </div>
  );
}

function EvidenceList({ refs = [], items, context }: { refs?: string[]; items?: EvidenceItem[]; context: EvidenceContext }) {
  return <EvidenceItemsList items={items && items.length > 0 ? items : evidenceItems(refs, context)} ariaLabel="Supporting evidence" />;
}

function GoalHistoryAttachmentList({ attachments = [] }: { attachments?: Array<{ name: string; contentPath: string | null }> }) {
  if (attachments.length === 0) return null;
  return (
    <div aria-label="Feedback attachments" className="flex min-w-0 flex-wrap gap-2 text-xs text-muted-foreground">
      {attachments.map((attachment, index) => {
        const content = (
          <>
            <Paperclip className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 break-all">{attachment.name}</span>
          </>
        );
        return attachment.contentPath ? (
          <a
            key={`${attachment.name}:${index}`}
            href={attachment.contentPath}
            className="inline-flex max-w-full min-w-0 items-center gap-1 text-xs text-foreground underline decoration-border underline-offset-2"
          >
            {content}
          </a>
        ) : (
          <span key={`${attachment.name}:${index}`} className="inline-flex max-w-full min-w-0 items-center gap-1">
            {content}
          </span>
        );
      })}
    </div>
  );
}

function GoalFeedbackActivity({
  actorName,
  item,
}: {
  actorName: string;
  item: Extract<GoalActivityTimelinePage["items"][number], { source: "goal-history" }>["item"];
}) {
  return (
    <article
      data-testid={`goal-feedback-${item.id}`}
      className="min-w-0 overflow-hidden rounded-sm border border-border p-3"
    >
      <CommentThreadActivityRow
        actorName={actorName}
        description={<span className="text-muted-foreground/90">Feedback</span>}
        createdAt={item.createdAt}
        marker={<CircleDot className="h-3.5 w-3.5 text-muted-foreground/70" />}
        testId={`goal-feedback-heading-${item.id}`}
      />
      <div className="ml-7 mt-2 min-w-0">
        <MarkdownBody className="min-w-0 break-words text-sm leading-6 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
          {item.summary}
        </MarkdownBody>
        <div className="mt-2">
          <GoalHistoryAttachmentList attachments={item.attachments} />
        </div>
      </div>
    </article>
  );
}

function ResultProposalSummary({ proposal, accepted = false }: { proposal: ResultProposalView; accepted?: boolean }) {
  return (
    <>
      <div className="mt-3 min-w-0">
        <div className="text-xs font-medium text-muted-foreground">Outcome</div>
        <p className="mt-1 whitespace-pre-wrap break-words text-sm font-medium leading-6">{proposal.outcome}</p>
      </div>
      <div className="mt-3 min-w-0">
        <div className="text-xs font-medium text-muted-foreground">Success criteria</div>
        <div className="mt-1 divide-y divide-border border-y border-border">
          {proposal.criteria.map((criterion, index) => (
            <div key={`${criterion.label}:${index}`} className="flex min-w-0 items-start justify-between gap-3 py-2 text-sm">
              <span className="min-w-0 whitespace-pre-wrap break-words">{criterion.label}</span>
              <span className={cn(
                "shrink-0 text-xs font-medium",
                criterion.status === "met" && "text-emerald-700 dark:text-emerald-400",
                (criterion.status === "unmet" || criterion.status === "breached") && "text-destructive",
                criterion.status === "unknown" && "text-amber-700 dark:text-amber-400",
              )}>{criterion.statusLabel}</span>
            </div>
          ))}
        </div>
      </div>
      {proposal.risks || proposal.gaps.length > 0 ? <div className="mt-3 min-w-0">
        <div className="text-xs font-medium text-muted-foreground">{accepted ? "Result notes" : "Risks and gaps"}</div>
        {proposal.risks ? <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6">{proposal.risks}</p> : null}
        {proposal.gaps.length > 0 ? (
          <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
            {proposal.gaps.map((gap) => <li key={gap} className="min-w-0 whitespace-pre-wrap break-words">{gap}</li>)}
          </ul>
        ) : null}
      </div> : null}
      <div className="mt-3 min-w-0">
        <div className="text-xs font-medium text-muted-foreground">Evidence check</div>
        <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6">{proposal.evidenceCheck}</p>
      </div>
      <div className="mt-3 min-w-0" aria-label="Result evidence">
        <div className="text-xs font-medium text-muted-foreground">Evidence</div>
        {proposal.evidence.length > 0 ? (
          <EvidenceItemsList items={proposal.evidence} ariaLabel="Inspectable result evidence" />
        ) : <p className="mt-1 text-xs text-muted-foreground">No supporting references attached.</p>}
      </div>
    </>
  );
}

function WorkLinks({ projects, issues, limit }: { projects: Project[]; issues: Issue[]; limit?: number }) {
  if (projects.length === 0 && issues.length === 0) return <p className="text-sm text-muted-foreground">No linked work.</p>;
  const entries = [
    ...projects.map((project) => ({ kind: "project" as const, project })),
    ...issues.map((issue) => ({ kind: "issue" as const, issue })),
  ];
  const visibleEntries = typeof limit === "number" ? entries.slice(0, limit) : entries;
  return (
    <div className="divide-y divide-border border-y border-border">
      {visibleEntries.map((entry) => entry.kind === "project" ? (
        <Link key={`project-${entry.project.id}`} to={projectUrl(entry.project)} className="flex min-w-0 items-start justify-between gap-3 px-1 py-2 text-sm hover:bg-accent/35">
          <span className="min-w-0 break-words">{entry.project.name}</span>
          <span className="shrink-0 text-xs text-muted-foreground">Project</span>
        </Link>
      ) : (
        <Link key={`issue-${entry.issue.id}`} to={issueUrl(entry.issue)} className="flex min-w-0 items-start justify-between gap-3 px-1 py-2 text-sm hover:bg-accent/35">
          <span className="shrink-0">{entry.issue.identifier ?? "Issue"}</span>
          <span className="min-w-0 break-words text-right text-xs text-muted-foreground">{entry.issue.title}</span>
        </Link>
      ))}
    </div>
  );
}

function facetLabel(facet: GoalWorkspaceFacet | string) {
  if (facet === "closed") return "History";
  if (facet === "ready_for_acceptance") return "Ready for acceptance";
  if (facet === "needs_attention" || facet === "needs_your_attention") return "Needs your attention";
  if (facet === "waiting_focus") return "Ready for Agent work";
  if (facet === "waiting_external" || facet === "waiting_for_external_result") return "Waiting for external result";
  return "Agent advancing";
}

function resultProposalHistoryLabel(status: string) {
  if (status === "accepted") return "Accepted result";
  if (status === "rejected") return "Result proposal rejected";
  if (status === "superseded") return "Result proposal superseded";
  if (status === "inconclusive") return "Result needs more evidence";
  if (status === "ready") return "Result ready for review";
  return "Result proposal";
}

function attentionKindLabel(kind: string) {
  if (kind === "result_proposal" || kind === "accept") return "Result ready for review";
  if (kind === "change_proposal" || kind === "approval") return "Goal update needs approval";
  if (kind === "alignment_question" || kind === "clarification") return "Goal needs clarification";
  if (kind === "owner_blocked") return "Agent needs attention";
  return "Action needed";
}

function buildGoalTimelineActivityItems({
  items: timelineItems,
  runById,
  sessionUserId,
  pendingFeedback,
  goalLifecycle,
  onRetryFeedback,
}: {
  items: GoalTimelineItem[];
  runById: Map<string, LinkedRunItem>;
  sessionUserId?: string;
  pendingFeedback: PendingFeedback | null;
  goalLifecycle?: string;
  onRetryFeedback: (feedback: PendingFeedback) => void;
}): CommentThreadActivityItem[] {
  const items = timelineItems
    .filter((entry): entry is Extract<GoalActivityTimelinePage["items"][number], { source: "goal-history" }> => entry.source === "goal-history")
    .map(({ item }) => {
      const actorLabel = item.actorType === "user" && item.actorId === sessionUserId ? "You" : item.actorName;
      const linkedRun = item.runId ? runById.get(item.runId) : null;
      const kindLabel = item.kind === "activity"
        ? "Progress update"
        : item.kind === "feedback"
          ? "Feedback"
          : item.kind === "change_proposal"
            ? "Proposed Goal update"
            : item.kind === "result_proposal"
              ? resultProposalHistoryLabel(item.status ?? "")
              : item.kind === "work_status"
                ? "Related work"
                : "Goal update";
      return {
        id: `goal-history:${item.kind}:${item.id}`,
        createdAt: item.createdAt,
        node: item.kind === "feedback" ? (
          <GoalFeedbackActivity actorName={actorLabel} item={item} />
        ) : (
          <div className="min-w-0 space-y-1">
            <CommentThreadActivityRow
              actorName={actorLabel}
              description={(
                <>
                  <span className="shrink-0 text-muted-foreground/90">{kindLabel}:</span>
                  <span data-testid={`goal-activity-summary-${item.id}`} className="min-w-0 truncate">{item.summary}</span>
                </>
              )}
              createdAt={item.createdAt}
              marker={<CircleDot className="h-3.5 w-3.5 text-muted-foreground/70" />}
              testId={`goal-activity-${item.id}`}
              runId={item.runId}
              runAgentId={linkedRun?.agentId ?? (item.actorType === "agent" ? item.actorId : null)}
            />
            <div className="ml-7 min-w-0"><GoalHistoryAttachmentList attachments={item.attachments} /></div>
          </div>
        ),
      };
    });

  if (pendingFeedback && goalLifecycle === "active") {
    items.push({
      id: `pending-feedback:${pendingFeedback.idempotencyKey}`,
      createdAt: pendingFeedback.createdAt,
      node: (
        <div data-testid="pending-goal-feedback" className="min-w-0 space-y-1">
          <CommentThreadActivityRow
            actorName="You"
            description={<span className={pendingFeedback.status === "failed" ? "text-destructive" : undefined}>{pendingFeedback.status === "sending" ? "Posting..." : "Not posted"}</span>}
            createdAt={pendingFeedback.createdAt}
            marker={<CircleDot className="h-3.5 w-3.5 text-muted-foreground/70" />}
            testId="goal-pending-feedback-row"
          />
          <div className="ml-7 min-w-0 space-y-2 border-l border-border pl-3">
            <MarkdownBody className="min-w-0 break-words text-sm leading-6 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">{pendingFeedback.body}</MarkdownBody>
            {pendingFeedback.attachments.length > 0 ? (
              <div aria-label="Pending feedback attachments" className="flex min-w-0 flex-wrap gap-2 text-xs text-muted-foreground">
                {pendingFeedback.attachments.map((attachment) => <span key={attachment.uri} className="min-w-0 break-all">{attachment.name}</span>)}
              </div>
            ) : null}
            {pendingFeedback.error ? <p role="alert" className="text-xs text-destructive">{pendingFeedback.error}</p> : null}
            {pendingFeedback.status === "failed" ? <Button type="button" size="sm" variant="outline" onClick={() => onRetryFeedback(pendingFeedback)}>Retry comment</Button> : null}
          </div>
        </div>
      ),
    });
  }

  return items;
}

export {
  GOAL_DETAIL_TABS,
  buildGoalTimelineActivityItems,
  EvidenceList,
  GoalFeedbackActivity,
  GoalHistoryAttachmentList,
  ResultProposalSummary,
  Section,
  WorkLinks,
  asRecord,
  attentionKindLabel,
  facetLabel,
  goalDetailTab,
  goalStatusIconStatus,
  goalStatusLabel,
  mergeGoalTimelineItems,
  normalizeChangeProposals,
  normalizeResultProposals,
  resultProposalHistoryLabel,
  readString,
  storedGoalChatTarget,
};

export type {
  ChangeDecisionInput,
  ChangeProposalView,
  DecisionFocusRequest,
  EvidenceContext,
  EvidenceItem,
  GoalDetailTab,
  GoalTimelineItem,
  PendingFeedback,
  ResultDecisionInput,
  ResultProposalView,
};
