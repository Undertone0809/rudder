import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Link, Navigate, useLocation, useNavigate, useParams } from "@/lib/router";
import {
  parseLibraryEntryMentionHref,
  parseLibraryFileMentionHref,
  type GoalDependencies,
  type GoalFeedbackAttachment,
  type GoalWorkspaceFacet,
  type Issue,
  type Project,
} from "@rudderhq/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Check,
  CircleDot,
  Clock3,
  ExternalLink,
  FileCheck2,
  Focus,
  History,
  MessageSquareText,
  Paperclip,
  Pencil,
  ShieldCheck,
  Sparkles,
  Target,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode, type Ref } from "react";
import { agentsApi } from "../api/agents";
import { assetsApi } from "../api/assets";
import { authApi } from "../api/auth";
import { goalsApi } from "../api/goals";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
import { InlineEditor } from "../components/InlineEditor";
import { MarkdownBody } from "../components/MarkdownBody";
import { PageSkeleton } from "../components/PageSkeleton";
import { StatusBadge } from "../components/StatusBadge";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useDialog } from "../context/DialogContext";
import { useOrganization } from "../context/OrganizationContext";
import { usePanel } from "../context/PanelContext";
import { useToast } from "../context/ToastContext";
import { toDateTimeLocalValue } from "../lib/datetime-local";
import { markdownDocumentOrNull } from "../lib/markdown-document-value";
import { findOrganizationByPrefix, getOrganizationRouteKey } from "../lib/organization-routes";
import { queryKeys } from "../lib/queryKeys";
import { cn, formatDate, issueUrl, projectUrl } from "../lib/utils";

type TimelineView = {
  id: string;
  kind: string;
  summary: string;
  createdAt: Date | string | null;
  evidenceRefs: string[];
  evidence: EvidenceItem[];
  actorName: string | null;
  actorType: string | null;
  actorId: string | null;
  status: string | null;
  attachments: Array<{
    name: string;
    mimeType: string | null;
    size: number | null;
    contentPath: string | null;
  }>;
};

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
    target ? `Target time: ${target}` : null,
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

function normalizeTimeline(value: unknown): TimelineView[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    const id = readString(record, "id");
    const summary = readString(record, "summary", "body");
    if (!id || !summary) return [];
    const createdAt = record.createdAt ?? record.occurredAt ?? null;
    const attachments = Array.isArray(record.attachments) ? record.attachments.flatMap((attachment) => {
      const attachmentRecord = asRecord(attachment);
      const name = readString(attachmentRecord, "name");
      if (!name) return [];
      return [{
        name,
        mimeType: readString(attachmentRecord, "mimeType"),
        size: typeof attachmentRecord.size === "number" && attachmentRecord.size >= 0 ? attachmentRecord.size : null,
        contentPath: readString(attachmentRecord, "contentPath"),
      }];
    }) : [];
    return [{
      id,
      kind: readString(record, "kind", "activityKind", "feedbackKind") ?? "update",
      summary,
      createdAt: typeof createdAt === "string" || createdAt instanceof Date ? createdAt : null,
      evidenceRefs: readStringArray(record.evidenceRefs),
      evidence: normalizeEvidenceItems(record.evidence),
      actorName: readString(record, "actorName", "submittedByName"),
      actorType: readString(record, "actorType"),
      actorId: readString(record, "actorId"),
      status: readString(record, "status"),
      attachments,
    }];
  });
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

function AttachmentList({ attachments }: { attachments: TimelineView["attachments"] }) {
  if (attachments.length === 0) return null;
  return (
    <div aria-label="Feedback attachments" className="flex min-w-0 flex-wrap gap-2 pt-1">
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
          <span key={`${attachment.name}:${index}`} className="inline-flex max-w-full min-w-0 items-center gap-1 text-xs text-muted-foreground">
            {content}
          </span>
        );
      })}
    </div>
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

function WorkLinks({ projects, issues }: { projects: Project[]; issues: Issue[] }) {
  if (projects.length === 0 && issues.length === 0) return <p className="text-sm text-muted-foreground">No linked work.</p>;
  return (
    <div className="divide-y divide-border border-y border-border">
      {projects.map((project) => (
        <Link key={`project-${project.id}`} to={projectUrl(project)} className="flex min-w-0 items-start justify-between gap-3 px-1 py-2 text-sm hover:bg-accent/35">
          <span className="min-w-0 break-words">{project.name}</span>
          <span className="shrink-0 text-xs text-muted-foreground">Project</span>
        </Link>
      ))}
      {issues.map((issue) => (
        <Link key={`issue-${issue.id}`} to={issueUrl(issue)} className="flex min-w-0 items-start justify-between gap-3 px-1 py-2 text-sm hover:bg-accent/35">
          <span className="shrink-0">{issue.identifier ?? "Issue"}</span>
          <span className="min-w-0 break-words text-right text-xs text-muted-foreground">{issue.title}</span>
        </Link>
      ))}
    </div>
  );
}

const dependencyLabels: Record<string, string> = {
  childGoals: "Child Goals",
  linkedProjects: "Linked projects",
  linkedIssues: "Linked issues",
  automations: "Automations",
  calendarEvents: "Calendar events",
};

function DeletionBlockers({ dependencies }: { dependencies: GoalDependencies }) {
  const previewGroups = Object.entries(dependencies.previews).filter(([, previews]) => previews.length > 0);
  if (dependencies.canDelete || (previewGroups.length === 0 && dependencies.blockers.length === 0)) return null;
  return (
    <div className="space-y-2 border-l-2 border-amber-500/45 pl-3">
      <div className="text-xs font-medium">Deletion blockers</div>
      {previewGroups.map(([kind, previews]) => (
        <div key={kind} className="text-xs text-muted-foreground">
          <div className="font-medium text-foreground">{dependencyLabels[kind] ?? kind}</div>
          {previews.map((preview) => <div key={preview.id} className="mt-1 min-w-0 break-words">{preview.title}</div>)}
        </div>
      ))}
    </div>
  );
}

function facetLabel(facet: GoalWorkspaceFacet | string) {
  if (facet === "closed") return "History";
  if (facet === "ready_for_acceptance") return "Ready for acceptance";
  if (facet === "needs_attention" || facet === "needs_your_attention") return "Needs your attention";
  if (facet === "waiting_focus") return "Waiting to start";
  if (facet === "waiting_external" || facet === "waiting_for_external_result") return "Waiting for external result";
  return "Agent advancing";
}

function timelineKindLabel(kind: string) {
  if (kind === "activity") return "Progress update";
  if (kind === "feedback") return "Feedback";
  if (kind === "change_proposal") return "Proposed Goal update";
  if (kind === "result_proposal") return "Proposed result";
  if (kind === "work_status") return "Related work";
  if (kind === "evidence") return "Evidence update";
  return "Goal update";
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

export function GoalDetail() {
  const { goalId, orgPrefix } = useParams<{ goalId: string; orgPrefix?: string }>();
  const location = useLocation();
  const debugMode = new URLSearchParams(location.search).get("goalDebug") === "1";
  const { organizations, selectedOrganizationId } = useOrganization();
  const { confirm, openNewGoal, promptText } = useDialog();
  const { closePanel } = usePanel();
  const { pushToast } = useToast();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const feedbackRef = useRef<HTMLTextAreaElement>(null);
  const feedbackFileRef = useRef<HTMLInputElement>(null);
  const focusButtonRef = useRef<HTMLButtonElement>(null);
  const outcomeHeadingRef = useRef<HTMLHeadingElement>(null);
  const attentionHeadingRef = useRef<HTMLHeadingElement>(null);
  const historyFocusRef = useRef<HTMLDivElement>(null);
  const feedbackRequestRef = useRef<{ identity: string; key: string } | null>(null);
  const resultRequestKeysRef = useRef(new Map<string, string>());
  const decisionFocusRequestRef = useRef<DecisionFocusRequest | null>(null);
  const focusControlRequestRef = useRef<{ goalId: string; focus: boolean } | null>(null);
  const [feedbackBody, setFeedbackBody] = useState("");
  const [feedbackAttachments, setFeedbackAttachments] = useState<GoalFeedbackAttachment[]>([]);
  const [feedbackAttachmentError, setFeedbackAttachmentError] = useState<string | null>(null);
  const [failedFeedbackFile, setFailedFeedbackFile] = useState<File | null>(null);
  const [pendingFeedback, setPendingFeedback] = useState<PendingFeedback | null>(null);
  const [changeNotes, setChangeNotes] = useState<Record<string, string>>({});
  const [resultFeedback, setResultFeedback] = useState<Record<string, string>>({});
  const [historyPages, setHistoryPages] = useState<unknown[][]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null | undefined>(undefined);
  const [historyFocusKey, setHistoryFocusKey] = useState<string | null>(null);

  const workspaceQuery = useQuery({
    queryKey: ["goals", "detail", goalId, "workspace"],
    queryFn: () => goalsApi.getWorkspace(goalId!),
    enabled: Boolean(goalId),
  });
  const workspace = workspaceQuery.data;
  const goal = workspace?.goal;
  const routeOrganization = findOrganizationByPrefix({ organizations, organizationPrefix: orgPrefix });
  const routeOrganizationId = routeOrganization?.id ?? selectedOrganizationId;
  const goalOrganization = goal
    ? organizations.find((organization) => organization.id === goal.orgId) ?? null
    : null;
  const canonicalGoalPath = goal && routeOrganizationId && goal.orgId !== routeOrganizationId && goalOrganization
    ? `/${getOrganizationRouteKey(goalOrganization)}/goals/${goal.id}${location.search}${location.hash}`
    : null;
  const orgId = routeOrganizationId;
  const sessionQuery = useQuery({
    queryKey: ["auth", "session"],
    queryFn: () => authApi.getSession(),
  });

  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(orgId!),
    queryFn: () => agentsApi.list(orgId!),
    enabled: Boolean(orgId),
  });
  const projectsQuery = useQuery({
    queryKey: queryKeys.projects.list(orgId!),
    queryFn: () => projectsApi.list(orgId!),
    enabled: Boolean(orgId),
  });
  const issuesQuery = useQuery({
    queryKey: queryKeys.issues.list(orgId!),
    queryFn: () => issuesApi.list(orgId!),
    enabled: Boolean(orgId),
  });
  const dependenciesQuery = useQuery({
    queryKey: queryKeys.goals.dependencies(goalId!),
    queryFn: () => goalsApi.dependencies(goalId!),
    enabled: Boolean(goalId),
  });

  useEffect(() => closePanel(), [closePanel]);
  useEffect(() => {
    setBreadcrumbs([{ label: "Goals", href: "/goals" }, { label: goal?.title ?? goalId ?? "Goal" }]);
  }, [goal?.title, goalId, setBreadcrumbs]);

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.goals.detail(goalId!) }),
      orgId ? queryClient.invalidateQueries({ queryKey: queryKeys.goals.list(orgId) }) : Promise.resolve(),
      orgId ? queryClient.invalidateQueries({ queryKey: ["goals", "workspace", orgId] }) : Promise.resolve(),
      queryClient.invalidateQueries({ queryKey: queryKeys.goals.dependencies(goalId!) }),
    ]);
  };

  const updateGoal = useMutation({
    mutationFn: (data: Record<string, unknown>) => goalsApi.update(goalId!, data),
    onSuccess: async () => {
      await invalidate();
      pushToast({ id: "goal-detail-operation", title: "Goal updated", tone: "success" });
    },
    onError: (error: Error) => pushToast({ title: error.message, tone: "error" }),
  });
  const setFocus = useMutation({
    mutationFn: (focus: boolean) => goalsApi.setFocus(goalId!, focus),
    onMutate: (focus) => {
      focusControlRequestRef.current = { goalId: goalId!, focus };
    },
    onSuccess: async () => {
      await invalidate();
      pushToast({ id: "goal-detail-operation", title: "Focus updated", tone: "success" });
    },
    onError: (error: Error) => {
      focusControlRequestRef.current = null;
      pushToast({ title: error.message, tone: "error" });
    },
  });
  const resumeOwner = useMutation({
    mutationFn: () => {
      if (!goal?.ownerAgentId || !orgId) throw new Error("This Goal has no available Owner Agent.");
      return agentsApi.resume(goal.ownerAgentId, orgId);
    },
    onSuccess: async () => {
      await invalidate();
      await queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(orgId!) });
      pushToast({ id: "goal-detail-operation", title: "Agent resumed", tone: "success" });
    },
    onError: (error: Error) => pushToast({ title: error.message, tone: "error" }),
  });
  const deleteGoal = useMutation({
    mutationFn: () => goalsApi.remove(goalId!),
    onSuccess: () => {
      if (orgId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.goals.list(orgId) });
        queryClient.invalidateQueries({ queryKey: ["goals", "workspace", orgId] });
      }
      navigate("/goals");
    },
    onError: (error: Error) => pushToast({ title: error.message, tone: "error" }),
  });

  const feedbackMutation = useMutation({
    mutationFn: (feedback: PendingFeedback) => goalsApi.feedback(goalId!, {
      body: feedback.body,
      attachments: feedback.attachments,
      feedbackKind: feedback.feedbackKind,
      idempotencyKey: feedback.idempotencyKey,
    }),
    onMutate: (feedback) => setPendingFeedback({ ...feedback, status: "sending", error: null }),
    onSuccess: async () => {
      await invalidate();
      setPendingFeedback(null);
      feedbackRequestRef.current = null;
      setFeedbackAttachments([]);
      requestAnimationFrame(() => feedbackRef.current?.focus());
    },
    onError: (error: Error, feedback) => {
      setPendingFeedback({ ...feedback, status: "failed", error: error.message });
      requestAnimationFrame(() => feedbackRef.current?.focus());
    },
  });

  const feedbackAttachmentMutation = useMutation({
    mutationFn: async ({ file }: { file: File }) => {
      if (!orgId) throw new Error("No organization selected");
      if (!file.type.startsWith("image/")) throw new Error("Only image attachments are supported right now.");
      return assetsApi.uploadImage(orgId, file, "goals/feedback");
    },
    onSuccess: (asset, { file }) => {
      setFeedbackAttachments((current) => [...current, {
        name: asset.originalFilename ?? file.name,
        uri: `asset://${asset.assetId}`,
        mimeType: asset.contentType,
        size: asset.byteSize,
      }]);
      setFeedbackAttachmentError(null);
      setFailedFeedbackFile(null);
    },
    onError: (error: Error, { file }) => {
      setFeedbackAttachmentError(error.message);
      setFailedFeedbackFile(file);
    },
  });

  const changeDecision = useMutation({
    mutationFn: ({ id, decision }: ChangeDecisionInput) => goalsApi.decideChangeProposal(id, {
      decision,
      note: changeNotes[id]?.trim() || undefined,
    }),
    onMutate: (variables) => {
      decisionFocusRequestRef.current = { goalId: variables.goalId, kind: "change", id: variables.id };
    },
    onSuccess: async () => {
      await invalidate();
    },
    onError: (_, variables) => {
      const request = decisionFocusRequestRef.current;
      if (request?.goalId === variables.goalId && request.kind === "change" && request.id === variables.id) {
        decisionFocusRequestRef.current = null;
      }
    },
  });

  const resultDecision = useMutation<unknown, Error, ResultDecisionInput>({
    mutationFn: ({ id, decision, feedback, idempotencyKey }) => decision === "accept"
      ? goalsApi.acceptResultProposal(id, { idempotencyKey })
      : goalsApi.rejectResultProposal(id, { idempotencyKey, feedback }),
    onMutate: (variables) => {
      decisionFocusRequestRef.current = { goalId: variables.goalId, kind: "result", id: variables.id };
    },
    onSuccess: async (_, variables) => {
      await invalidate();
      if (variables.decision === "reject") {
        setResultFeedback((current) => ({ ...current, [variables.id]: "" }));
      }
    },
    onError: (_, variables) => {
      const request = decisionFocusRequestRef.current;
      if (request?.goalId === variables.goalId && request.kind === "result" && request.id === variables.id) {
        decisionFocusRequestRef.current = null;
      }
    },
  });

  const historyMutation = useMutation({
    mutationFn: (cursor: string) => goalsApi.getHistory(goalId!, cursor),
    onSuccess: (page) => {
      setHistoryPages((current) => [...current, page.items]);
      setHistoryCursor(page.nextCursor);
      const firstItem = page.items[0];
      setHistoryFocusKey(firstItem ? `${firstItem.kind}:${firstItem.id}` : null);
    },
  });

  useEffect(() => {
    setHistoryPages([]);
    setHistoryCursor(workspaceQuery.data?.timelineNextCursor ?? null);
    setHistoryFocusKey(null);
  }, [goalId, workspaceQuery.data?.timelineNextCursor]);

  useEffect(() => {
    if (!historyFocusKey) return;
    requestAnimationFrame(() => historyFocusRef.current?.focus());
  }, [historyFocusKey, historyPages]);

  const linkedProjects = useMemo(
    () => (projectsQuery.data ?? []).filter((project) => project.goalIds.includes(goalId!) || project.goalId === goalId),
    [goalId, projectsQuery.data],
  );
  const linkedIssues = useMemo(
    () => (issuesQuery.data ?? []).filter((issue) => issue.goalId === goalId),
    [goalId, issuesQuery.data],
  );
  const timeline = useMemo(() => {
    const normalized = normalizeTimeline([...(workspace?.timeline ?? []), ...historyPages.flat()]);
    const seen = new Set<string>();
    return normalized.filter((entry) => {
      const key = `${entry.kind}:${entry.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [historyPages, workspace?.timeline]);
  const changeProposals = useMemo(() => normalizeChangeProposals(workspace?.changeProposals), [workspace?.changeProposals]);
  const resultProposals = useMemo(
    () => normalizeResultProposals(workspace?.resultProposals, workspace?.goal.criteria, {
      issues: issuesQuery.data ?? [],
      projects: projectsQuery.data ?? [],
      ownerAgentId: workspace?.goal.ownerAgentId ?? null,
    }),
    [issuesQuery.data, projectsQuery.data, workspace?.goal.criteria, workspace?.goal.ownerAgentId, workspace?.resultProposals],
  );

  useLayoutEffect(() => {
    const request = decisionFocusRequestRef.current;
    if (!request || workspaceQuery.isFetching) return;
    if (request.goalId !== goalId) {
      decisionFocusRequestRef.current = null;
      return;
    }
    const decisionIsPending = request.kind === "change"
      ? changeDecision.isPending
      : resultDecision.isPending;
    if (decisionIsPending) return;
    const proposalIsStillActionable = request.kind === "change"
      ? changeProposals.some((proposal) => proposal.id === request.id && proposal.status === "pending")
      : resultProposals.some((proposal) => proposal.id === request.id && proposal.status === "ready");
    if (proposalIsStillActionable) return;

    const hasOtherActionableAttention = changeProposals.some(
      (proposal) => proposal.id !== request.id && proposal.status === "pending",
    ) || resultProposals.some(
      (proposal) => proposal.id !== request.id && proposal.status === "ready",
    ) || Boolean(workspace?.attention && workspace.attention.sourceId !== request.id);
    const attentionHeading = hasOtherActionableAttention ? attentionHeadingRef.current : null;
    const outcomeHeading = outcomeHeadingRef.current;
    const feedbackComposer = feedbackRef.current;
    const target = attentionHeading?.isConnected
      ? attentionHeading
      : outcomeHeading?.isConnected
        ? outcomeHeading
        : feedbackComposer?.isConnected
          ? feedbackComposer
          : null;
    if (!target) return;
    target.focus();
    decisionFocusRequestRef.current = null;
  }, [
    changeDecision.isPending,
    changeProposals,
    goalId,
    resultDecision.isPending,
    resultProposals,
    workspace?.attention,
    workspaceQuery.isFetching,
  ]);

  useLayoutEffect(() => {
    const request = focusControlRequestRef.current;
    if (!request || setFocus.isPending || workspaceQuery.isFetching) return;
    if (request.goalId !== goalId) {
      focusControlRequestRef.current = null;
      return;
    }
    if (workspace?.goal.focus !== request.focus) return;

    const focusButton = focusButtonRef.current;
    if (!focusButton?.isConnected) return;
    focusButton.focus();
    focusControlRequestRef.current = null;
  }, [goalId, setFocus.isPending, workspace?.goal.focus, workspaceQuery.isFetching]);

  if (workspaceQuery.isLoading) return <PageSkeleton variant="detail" />;
  if (canonicalGoalPath) return <Navigate to={canonicalGoalPath} replace />;
  if (workspaceQuery.error) {
    const message = workspaceQuery.error instanceof Error ? workspaceQuery.error.message : "Unable to load Goal";
    return (
      <div role="alert" className="space-y-3 py-8">
        <p className="text-sm font-medium text-destructive">{message}</p>
        <p className="text-sm text-muted-foreground">This Goal may have been removed or is no longer available.</p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={() => void workspaceQuery.refetch()}>Retry</Button>
          <Link to="/goals" className="inline-flex items-center rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-accent">
            Back to Goals
          </Link>
        </div>
      </div>
    );
  }
  if (!workspace || !goal) {
    return (
      <div role="alert" className="space-y-3 py-8">
        <p className="text-sm font-medium text-destructive">Goal not found</p>
        <p className="text-sm text-muted-foreground">This Goal may have been removed or is no longer available.</p>
        <Link to="/goals" className="inline-flex items-center rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-accent">
          Back to Goals
        </Link>
      </div>
    );
  }

  const lifecycle = goal.lifecycle ?? "draft";
  const isDraft = lifecycle === "draft";
  const isActive = lifecycle === "active";
  const isClosed = lifecycle === "closed";
  const owner = agentsQuery.data?.find((agent) => agent.id === goal.ownerAgentId) ?? null;
  const evidenceContext: EvidenceContext = {
    issues: issuesQuery.data ?? [],
    projects: projectsQuery.data ?? [],
    runAgentId: goal.ownerAgentId ?? null,
  };
  const currentGoalRecord = asRecord(workspace.currentGoal);
  const currentGoalSummary = readString(currentGoalRecord, "summary")
    ?? goal.outcomeStatement
    ?? goal.description
    ?? goal.title;
  const agentActionRecord = asRecord(workspace.agentAction);
  const agentAction = readString(agentActionRecord, "summary")
    ?? (isDraft ? "Work has not started while this Goal is being aligned." : "No active work has been reported yet.");
  const agentActionStatus = readString(agentActionRecord, "status");
  const agentActionHeading = agentActionStatus && ["succeeded", "completed", "failed", "cancelled", "timed_out"].includes(agentActionStatus)
    ? "Latest Agent activity"
    : "Agent is doing";
  const nextStepRecord = asRecord(workspace.nextStep);
  const nextStep = readString(nextStepRecord, "summary")
    ?? goal.continuationSummary
    ?? (isDraft ? workspace.attention?.reason : null)
    ?? "No next step has been recorded.";
  const wakeCondition = readString(nextStepRecord, "wakeCondition") ?? goal.wakeCondition ?? null;
  const readyProposals = resultProposals.filter((proposal) => proposal.status === "ready");
  const acceptedProposal = resultProposals.find((proposal) => proposal.status === "accepted") ?? null;
  const pendingChanges = changeProposals.filter((proposal) => proposal.status === "pending");
  const hasAttention = Boolean(workspace.attention || readyProposals.length > 0 || pendingChanges.length > 0);
  const evaluationOutcome = readString(asRecord(goal.evaluationResult), "outcome");

  const rename = async () => {
    const title = await promptText({ title: "Rename Goal", label: "Title", defaultValue: goal.title, confirmLabel: "Save" });
    if (title?.trim() && title.trim() !== goal.title) updateGoal.mutate({ title: title.trim() });
  };
  const remove = async () => {
    const dependencies = dependenciesQuery.data;
    if (dependencies && !dependencies.canDelete) {
      pushToast({ title: "Goal cannot be deleted", body: dependencies.blockers.join(", "), tone: "warn" });
      return;
    }
    if (await confirm({ title: "Delete draft Goal?", description: "This removes the unlinked draft record.", confirmLabel: "Delete", tone: "destructive" })) {
      deleteGoal.mutate();
    }
  };
  const continueAlignment = () => openNewGoal({
    draftId: goal.id,
    title: goal.title,
    context: goal.description ?? "",
    ownerAgentId: goal.ownerAgentId ?? "",
    targetTime: goal.evaluationDeadline ? toDateTimeLocalValue(goal.evaluationDeadline) : "",
  });
  const submitFeedback = () => {
    const body = feedbackBody.trim();
    if (!body || feedbackMutation.isPending) return;
    const feedbackKind = "ordinary" as const;
    const attachments = [...feedbackAttachments];
    const identity = `${feedbackKind}\0${body}\0${attachments.map((attachment) => attachment.uri).join("\0")}`;
    if (feedbackRequestRef.current?.identity !== identity) {
      feedbackRequestRef.current = { identity, key: crypto.randomUUID() };
    }
    const pending: PendingFeedback = {
      identity,
      idempotencyKey: feedbackRequestRef.current.key,
      body,
      attachments,
      feedbackKind,
      status: "sending",
      error: null,
    };
    setFeedbackBody("");
    feedbackMutation.mutate(pending);
  };
  const handleFeedbackFilePicked = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) feedbackAttachmentMutation.mutate({ file });
  };
  const removeFeedbackAttachment = (uri: string) => {
    setFeedbackAttachments((current) => current.filter((attachment) => attachment.uri !== uri));
    if (pendingFeedback?.status === "failed") {
      setFeedbackBody(pendingFeedback.body);
      setPendingFeedback(null);
      feedbackRequestRef.current = null;
    }
  };
  const resultKey = (proposalId: string, decision: "accept" | "reject", feedback = "") => {
    const identity = `${proposalId}:${decision}:${feedback.trim()}`;
    const existing = resultRequestKeysRef.current.get(identity);
    if (existing) return existing;
    const key = crypto.randomUUID();
    resultRequestKeysRef.current.set(identity, key);
    return key;
  };

  return (
    <div data-testid="goal-detail-workspace" className="min-w-0 space-y-5 overflow-x-hidden pb-[calc(5rem+env(safe-area-inset-bottom))] md:pb-8">
      <header className="min-w-0 space-y-3">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <StatusBadge status={lifecycle} />
            <span className="text-xs text-muted-foreground">{facetLabel(workspace.facet)}</span>
            {goal.focus ? <span className="text-xs font-medium text-[color:var(--accent-base)]">Focus Goal</span> : null}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {isDraft ? <Button size="sm" variant="outline" onClick={rename}><Pencil className="mr-1.5 h-3.5 w-3.5" />Rename</Button> : null}
            {isDraft ? <Button size="sm" onClick={continueAlignment}><Target className="mr-1.5 h-3.5 w-3.5" />Continue alignment</Button> : null}
            {isDraft ? <Button size="sm" variant="outline" onClick={remove} disabled={deleteGoal.isPending}><Trash2 className="mr-1.5 h-3.5 w-3.5" />Delete</Button> : null}
            {isActive ? <Button ref={focusButtonRef} size="sm" variant={goal.focus ? "outline" : "default"} onClick={() => setFocus.mutate(!goal.focus)} disabled={setFocus.isPending}><Focus className="mr-1.5 h-3.5 w-3.5" />{goal.focus ? "Unfocus" : "Set focus"}</Button> : null}
          </div>
        </div>
        {!isDraft ? (
          <>
            <h1 className="min-w-0 whitespace-normal break-words text-2xl font-semibold">{goal.title}</h1>
            {goal.description ? (
              <MarkdownBody className="min-w-0 break-words text-sm text-muted-foreground [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
                {goal.description}
              </MarkdownBody>
            ) : null}
          </>
        ) : (
          <>
            <InlineEditor value={goal.title} onSave={(title) => updateGoal.mutate({ title })} as="h1" className="min-w-0 whitespace-normal break-words text-2xl font-semibold" />
            <InlineEditor value={goal.description ?? ""} onSave={(description) => updateGoal.mutate({ description: markdownDocumentOrNull(description) })} as="p" className="min-w-0 whitespace-pre-wrap break-words text-sm text-muted-foreground" placeholder="Add context..." multiline editorEngine="codemirror" documentIdentity={`goal:${goal.id}`} />
          </>
        )}
      </header>

      <Section title="Outcome" icon={Target} headingRef={outcomeHeadingRef}>
        <p className="min-w-0 whitespace-pre-wrap break-words text-sm leading-6">{currentGoalSummary}</p>
        {currentGoalRecord.updatedFromEvidence === true ? <p className="text-xs text-muted-foreground">Updated from evidence and feedback</p> : null}
      </Section>

      <Section title="Current progress" icon={Sparkles}>
        <p className="min-w-0 whitespace-pre-wrap break-words text-sm leading-6">{workspace.currentProgress.summary}</p>
        {workspace.currentProgress.uncertainty ? <p className="min-w-0 whitespace-pre-wrap break-words text-xs text-muted-foreground">{workspace.currentProgress.uncertainty}</p> : null}
        <EvidenceList items={workspace.currentProgress.evidence ?? []} refs={[]} context={evidenceContext} />
      </Section>

      {!isClosed && hasAttention ? (
        <Section title="Needs your attention" icon={ShieldCheck} headingRef={attentionHeadingRef}>
          {workspace.attention ? (
            <div className="min-w-0 border-l-2 border-amber-500/50 pl-3">
              <div className="text-xs font-medium text-muted-foreground">{attentionKindLabel(workspace.attention.kind)}</div>
              <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6">{workspace.attention.reason}</p>
              {workspace.attention.impact ? <p className="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground">{workspace.attention.impact}</p> : null}
              <EvidenceList items={workspace.attention.evidence ?? []} refs={[]} context={evidenceContext} />
              {isDraft ? <Button type="button" size="sm" className="mt-3" onClick={continueAlignment}>Continue alignment</Button> : null}
              {workspace.attention.kind === "owner_blocked" && owner?.status === "paused" ? (
                <Button type="button" size="sm" className="mt-3" onClick={() => resumeOwner.mutate()} disabled={resumeOwner.isPending}>
                  {resumeOwner.isPending ? "Resuming..." : "Resume Agent"}
                </Button>
              ) : null}
            </div>
          ) : null}

          {pendingChanges.map((proposal) => {
            const isPending = changeDecision.isPending && changeDecision.variables?.id === proposal.id;
            const error = changeDecision.error && changeDecision.variables?.id === proposal.id ? changeDecision.error : null;
            return (
              <article
                key={proposal.id}
                aria-label="Goal change proposal"
                className="min-w-0 rounded-md border border-amber-500/35 bg-amber-500/5 p-3"
              >
                <div className="text-sm font-semibold">Proposed Goal change</div>
                <div className="mt-3 grid min-w-0 gap-3 sm:grid-cols-2">
                  <div className="min-w-0"><div className="text-xs font-medium text-muted-foreground">Before</div><p className="mt-1 whitespace-pre-wrap break-words text-sm">{proposal.before}</p></div>
                  <div className="min-w-0"><div className="text-xs font-medium text-muted-foreground">After</div><p className="mt-1 whitespace-pre-wrap break-words text-sm">{proposal.after}</p></div>
                </div>
                {proposal.rationale ? <p className="mt-3 whitespace-pre-wrap break-words text-sm">{proposal.rationale}</p> : null}
                {proposal.impact ? <p className="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground">Impact: {proposal.impact}</p> : null}
                <EvidenceList items={proposal.evidence} refs={proposal.evidenceRefs} context={evidenceContext} />
                <label className="mt-3 block text-xs text-muted-foreground">
                  Decision note
                  <input
                    className="mt-1 h-9 w-full min-w-0 rounded-md border border-border bg-background px-2.5 text-sm text-foreground outline-none focus:border-ring"
                    value={changeNotes[proposal.id] ?? ""}
                    onChange={(event) => {
                      changeDecision.reset();
                      setChangeNotes((current) => ({ ...current, [proposal.id]: event.target.value }));
                    }}
                  />
                </label>
                {error ? <p role="alert" className="mt-2 text-sm text-destructive">{error.message}</p> : null}
                <div className="mt-3 flex flex-wrap justify-end gap-2">
                  <Button type="button" size="sm" variant="outline" disabled={isPending} onClick={() => changeDecision.mutate({ goalId: goal.id, id: proposal.id, decision: "reject" })}>
                    {error && changeDecision.variables?.decision === "reject" ? "Retry reject" : "Reject"}
                  </Button>
                  <Button type="button" size="sm" disabled={isPending} onClick={() => changeDecision.mutate({ goalId: goal.id, id: proposal.id, decision: "approve" })}>
                    <Check className="mr-1.5 h-3.5 w-3.5" />{error && changeDecision.variables?.decision === "approve" ? "Retry approve" : "Approve"}
                  </Button>
                </div>
              </article>
            );
          })}

          {readyProposals.map((proposal) => {
            const rejection = resultFeedback[proposal.id] ?? "";
            const isPending = resultDecision.isPending && resultDecision.variables?.id === proposal.id;
            const error = resultDecision.error && resultDecision.variables?.id === proposal.id ? resultDecision.error : null;
            return (
              <article
                key={proposal.id}
                aria-label="Goal result proposal"
                className={cn(
                  "min-w-0 rounded-md border p-3",
                  proposal.outcomeKind === "not_achieved" || proposal.outcomeKind === "breached"
                    ? "border-destructive/35 bg-destructive/5"
                    : "border-emerald-500/35 bg-emerald-500/5",
                )}
              >
                <div className="text-sm font-semibold">Result proposed</div>
                <ResultProposalSummary proposal={proposal} />
                <label className="mt-3 block text-xs font-medium text-muted-foreground">
                  Why is this result not sufficient?
                  <Textarea
                    aria-label="Why is this result not sufficient?"
                    value={rejection}
                    onChange={(event) => {
                      resultDecision.reset();
                      setResultFeedback((current) => ({ ...current, [proposal.id]: event.target.value }));
                    }}
                    className="mt-1 min-h-16 resize-y bg-background text-sm text-foreground"
                  />
                </label>
                {error ? <p role="alert" className="mt-2 text-sm text-destructive">{error.message}</p> : null}
                <div className="mt-3 flex flex-wrap justify-end gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={isPending || !rejection.trim()}
                    onClick={() => resultDecision.mutate({
                      goalId: goal.id,
                      id: proposal.id,
                      decision: "reject",
                      feedback: rejection.trim(),
                      idempotencyKey: resultKey(proposal.id, "reject", rejection),
                    })}
                  >
                    {error && resultDecision.variables?.decision === "reject" ? "Retry rejection" : "Result is not sufficient"}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={isPending}
                    onClick={() => resultDecision.mutate({
                      goalId: goal.id,
                      id: proposal.id,
                      decision: "accept",
                      idempotencyKey: resultKey(proposal.id, "accept"),
                    })}
                  >
                    <FileCheck2 className="mr-1.5 h-3.5 w-3.5" />{error && resultDecision.variables?.decision === "accept" ? "Retry accept" : "Accept result"}
                  </Button>
                </div>
              </article>
            );
          })}
        </Section>
      ) : null}

      {isClosed ? (
        <Section title="Result accepted" icon={FileCheck2}>
          {acceptedProposal ? (
            <article aria-label="Accepted Goal result" className={cn(
              "min-w-0 border-l-2 pl-3",
              acceptedProposal.outcomeKind === "not_achieved" || acceptedProposal.outcomeKind === "breached"
                ? "border-destructive/45"
                : "border-emerald-500/50",
            )}>
              <ResultProposalSummary proposal={acceptedProposal} accepted />
            </article>
          ) : (
            <div className="min-w-0">
              <p className="text-sm font-medium">{evaluationOutcome ?? goal.status}</p>
              <p className="mt-1 text-xs text-muted-foreground">Accepted proposal details are not available for this earlier Goal.</p>
            </div>
          )}
        </Section>
      ) : null}

      {!isClosed ? (
        <>
          {readyProposals.length === 0 && pendingChanges.length === 0 ? (
            <Section title={agentActionHeading} icon={UserRound}>
              <p className="min-w-0 whitespace-pre-wrap break-words text-sm leading-6">{agentAction}</p>
              <p className="min-w-0 break-words text-xs text-muted-foreground">Owner: {owner?.name ?? (goal.ownerAgentId ? "Owner unavailable" : "Unassigned")}</p>
            </Section>
          ) : null}

          <Section title="Next step" icon={ArrowRight}>
            <p className="min-w-0 whitespace-pre-wrap break-words text-sm leading-6">{nextStep}</p>
            {wakeCondition ? <p className="min-w-0 whitespace-pre-wrap break-words text-xs text-muted-foreground">Resume when: {wakeCondition}</p> : null}
          </Section>
        </>
      ) : null}

      <Section title={isClosed ? "History" : "Progress and feedback"} icon={History}>
        <div className="divide-y divide-border border-y border-border">
          {timeline.length === 0 && !(isActive && pendingFeedback) ? <p className="py-3 text-sm text-muted-foreground">No progress or feedback yet.</p> : null}
          {timeline.map((entry) => {
            const entryKey = `${entry.kind}:${entry.id}`;
            const receivesHistoryFocus = entryKey === historyFocusKey;
            return (
            <div
              key={entryKey}
              ref={receivesHistoryFocus ? historyFocusRef : undefined}
              tabIndex={receivesHistoryFocus ? -1 : undefined}
              className="min-w-0 space-y-1 rounded-sm py-2.5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 break-all text-xs font-medium text-muted-foreground">
                  {entry.actorType === "user" && entry.actorId && entry.actorId === sessionQuery.data?.user.id
                    ? "You"
                    : entry.actorName ?? timelineKindLabel(entry.kind)}
                </div>
                {entry.createdAt ? <div className="shrink-0 text-xs text-muted-foreground">{formatDate(entry.createdAt)}</div> : null}
              </div>
              {entry.kind === "result_proposal" && entry.status ? (
                <div className="text-xs font-medium text-muted-foreground">
                  {resultProposalHistoryLabel(entry.status)}
                </div>
              ) : null}
              <p className="min-w-0 whitespace-pre-wrap break-words text-sm leading-6">{entry.summary}</p>
              <EvidenceList
                items={entry.evidence}
                refs={entry.evidenceRefs}
                context={{
                  ...evidenceContext,
                  runAgentId: entry.actorType === "agent" && entry.actorId
                    ? entry.actorId
                    : evidenceContext.runAgentId,
                }}
              />
              <AttachmentList attachments={entry.attachments} />
            </div>
            );
          })}
          {isActive && pendingFeedback ? (
            <div className={cn("min-w-0 space-y-1 py-2.5", pendingFeedback.status === "failed" && "text-destructive")}>
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                <div className="text-xs font-medium">You</div>
                <div className="text-xs">{pendingFeedback.status === "sending" ? "Sending..." : "Not sent"}</div>
              </div>
              <p className="min-w-0 whitespace-pre-wrap break-words text-sm leading-6">{pendingFeedback.body}</p>
              {pendingFeedback.attachments.length > 0 ? (
                <div aria-label="Pending feedback attachments" className="flex min-w-0 flex-wrap gap-2 pt-1">
                  {pendingFeedback.attachments.map((attachment) => (
                    <span key={attachment.uri} className="inline-flex max-w-full min-w-0 items-center gap-1 text-xs text-muted-foreground">
                      <Paperclip className="h-3.5 w-3.5 shrink-0" />
                      <span className="break-all">{attachment.name}</span>
                    </span>
                  ))}
                </div>
              ) : null}
              {pendingFeedback.error ? <p role="alert" className="text-xs">{pendingFeedback.error}</p> : null}
              {pendingFeedback.status === "failed" ? (
                <Button type="button" size="sm" variant="outline" onClick={() => feedbackMutation.mutate(pendingFeedback)}>Retry feedback</Button>
              ) : null}
            </div>
          ) : null}
          {historyCursor ? (
            <div className="py-3 text-center">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={historyMutation.isPending}
                onClick={() => historyMutation.mutate(historyCursor)}
              >
                {historyMutation.isPending ? "Loading..." : historyMutation.isError ? "Retry earlier records" : "Load earlier records"}
              </Button>
              {historyMutation.isError ? <p role="alert" className="mt-2 text-xs text-destructive">{historyMutation.error.message}</p> : null}
            </div>
          ) : null}
        </div>

        {isActive ? <div className="min-w-0 space-y-2">
          <input
            ref={feedbackFileRef}
            type="file"
            accept="image/*"
            aria-label="Attach feedback image"
            className="hidden"
            onChange={handleFeedbackFilePicked}
          />
          {feedbackAttachments.length > 0 ? (
            <div aria-label="Selected feedback attachments" className="flex min-w-0 flex-wrap gap-2">
              {feedbackAttachments.map((attachment) => (
                <span key={attachment.uri} className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground">
                  <Paperclip className="h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 break-all">{attachment.name}</span>
                  <button
                    type="button"
                    className="ml-1 shrink-0 rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
                    aria-label={`Remove feedback attachment ${attachment.name}`}
                    onClick={() => removeFeedbackAttachment(attachment.uri)}
                    disabled={feedbackAttachmentMutation.isPending || feedbackMutation.isPending}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          {feedbackAttachmentError ? (
            <div className="flex flex-wrap items-center gap-2 text-xs text-destructive">
              <span role="alert">{feedbackAttachmentError}</span>
              {failedFeedbackFile ? (
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto p-0 text-xs"
                  onClick={() => feedbackAttachmentMutation.mutate({ file: failedFeedbackFile })}
                  disabled={feedbackAttachmentMutation.isPending}
                >
                  Retry attachment
                </Button>
              ) : null}
            </div>
          ) : null}
          <Textarea
            ref={feedbackRef}
            aria-label="Goal feedback"
            value={feedbackBody}
            onChange={(event) => {
              feedbackMutation.reset();
              setFeedbackBody(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                submitFeedback();
              }
            }}
            placeholder="Add a fact, correction, concern, or direction..."
            className="min-h-20 min-w-0 resize-y"
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => feedbackFileRef.current?.click()}
              disabled={feedbackAttachmentMutation.isPending || feedbackMutation.isPending}
            >
              <Paperclip className="mr-1.5 h-3.5 w-3.5" />
              {feedbackAttachmentMutation.isPending ? "Uploading..." : "Attach image"}
            </Button>
            <Button type="button" size="sm" onClick={submitFeedback} disabled={!feedbackBody.trim() || feedbackMutation.isPending || feedbackAttachmentMutation.isPending}>
              <MessageSquareText className="mr-1.5 h-3.5 w-3.5" />Send feedback
            </Button>
          </div>
        </div> : null}
      </Section>

      <Section title="Goal details and related work" icon={Clock3}>
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <div className="min-w-0"><div className="text-xs text-muted-foreground">Owner</div><div className="mt-1 min-w-0 break-words text-sm">{owner?.name ?? (goal.ownerAgentId ? "Owner unavailable" : "Unassigned")}</div></div>
          <div className="min-w-0"><div className="text-xs text-muted-foreground">Target time</div><div className="mt-1 min-w-0 break-words text-sm">{goal.evaluationDeadline || goal.actionDeadline ? formatDate(goal.evaluationDeadline ?? goal.actionDeadline!) : "Not set"}</div></div>
        </div>
        {goal.criteria && goal.criteria.length > 0 ? (
          <div className="space-y-2 border-y border-border py-3">
            <div className="text-xs font-medium text-muted-foreground">How we will know it worked</div>
            {goal.criteria.map((criterion) => <div key={criterion.id} className="min-w-0 py-2 text-sm"><span className="whitespace-pre-wrap break-words">{criterion.label}</span></div>)}
          </div>
        ) : null}
        <WorkLinks projects={linkedProjects} issues={linkedIssues} />
        {isDraft && dependenciesQuery.data ? <DeletionBlockers dependencies={dependenciesQuery.data} /> : null}
      </Section>

      {debugMode ? (
        <Section title="Goal diagnostics" icon={ShieldCheck}>
          <pre className="max-w-full overflow-x-auto whitespace-pre-wrap break-words border border-border bg-muted/20 p-3 text-xs leading-5">{JSON.stringify(workspace, null, 2)}</pre>
        </Section>
      ) : null}
    </div>
  );
}
