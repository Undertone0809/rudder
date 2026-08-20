import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Link, Navigate, useLocation, useNavigate, useParams } from "@/lib/router";
import type { SidePanelTarget } from "@/lib/side-panel-targets";
import {
  parseLibraryEntryMentionHref,
  parseLibraryFileMentionHref,
  type GoalFeedbackAttachment,
  type GoalWorkspaceFacet,
  type Issue,
  type Project,
} from "@rudderhq/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity as ActivityIcon,
  ArrowRight,
  CalendarDays,
  Check,
  CircleDot,
  Clock3,
  Copy,
  ExternalLink,
  FileCheck2,
  Focus,
  History,
  MessageSquare,
  MessageSquareText,
  MoreHorizontal,
  Paperclip,
  Pencil,
  ShieldCheck,
  Sparkles,
  Target,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import { agentsApi } from "../api/agents";
import { assetsApi } from "../api/assets";
import { authApi } from "../api/auth";
import { goalsApi } from "../api/goals";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
import { AgentIdentity } from "../components/AgentAvatar";
import { AgentMenuLabel } from "../components/AssigneeLabel";
import { CommentComposer } from "../components/CommentComposer";
import { GoalTargetTimePicker } from "../components/GoalTargetTimePicker";
import { InlineEditor } from "../components/InlineEditor";
import { PropertyPicker, PropertyRow } from "../components/IssueProperties";
import { IssueRuntimeSelector, supportsIssueRuntimeOverrides } from "../components/IssueRuntimeSelector";
import { MarkdownBody } from "../components/MarkdownBody";
import type { MarkdownEditorRef } from "../components/MarkdownEditor";
import { PageSkeleton } from "../components/PageSkeleton";
import { PropertiesManifest, PropertiesManifestSheet, PropertiesManifestTrigger } from "../components/PropertiesManifest";
import { StatusBadge } from "../components/StatusBadge";
import { StatusIcon } from "../components/StatusIcon";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useDialog } from "../context/DialogContext";
import { useOrganization } from "../context/OrganizationContext";
import { usePanel } from "../context/PanelContext";
import { useSidePanel } from "../context/SidePanelContext";
import { useToast } from "../context/ToastContext";
import { formatDateOnly, toDateOnlyValue } from "../lib/date-only";
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

const goalStatusIconStatus: Record<string, string> = {
  planned: "todo",
  active: "in_progress",
  achieved: "done",
  cancelled: "cancelled",
};

function goalStatusLabel(status: string) {
  return status.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

const GOAL_DETAIL_TABS = ["conversation", "activity"] as const;
type GoalDetailTab = (typeof GOAL_DETAIL_TABS)[number];

function goalDetailTab(search: string): GoalDetailTab {
  const value = new URLSearchParams(search).get("tab");
  if (value === "activity") return "activity";
  return GOAL_DETAIL_TABS.includes(value as GoalDetailTab) ? value as GoalDetailTab : "conversation";
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
  const activeTab = goalDetailTab(location.search);
  const { organizations, selectedOrganizationId } = useOrganization();
  const { confirm, openNewGoal } = useDialog();
  const { closePanel } = usePanel();
  const sidePanel = useSidePanel();
  const { pushToast } = useToast();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const feedbackRef = useRef<MarkdownEditorRef>(null);
  const feedbackSurfaceRef = useRef<HTMLDivElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const focusButtonRef = useRef<HTMLButtonElement>(null);
  const goalTitleRef = useRef<HTMLHeadingElement>(null);
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
  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [titleError, setTitleError] = useState<string | null>(null);
  const [copiedGoalId, setCopiedGoalId] = useState(false);
  const [relatedExpanded, setRelatedExpanded] = useState(false);
  const [desktopOwnerOpen, setDesktopOwnerOpen] = useState(false);
  const [desktopOwnerSearch, setDesktopOwnerSearch] = useState("");
  const [mobileOwnerOpen, setMobileOwnerOpen] = useState(false);
  const [mobileOwnerSearch, setMobileOwnerSearch] = useState("");
  const [mobilePropsOpen, setMobilePropsOpen] = useState(false);

  const focusFeedbackComposer = useCallback(() => {
    let attempts = 0;
    const focusWhenReady = () => {
      attempts += 1;
      feedbackRef.current?.focus();
      const editable = feedbackSurfaceRef.current?.querySelector<HTMLElement>('[contenteditable="true"]');
      if (!editable) {
        if (attempts < 12) requestAnimationFrame(focusWhenReady);
        return;
      }
      if (document.activeElement !== editable) editable.focus({ preventScroll: true });
      if (attempts < 4) requestAnimationFrame(focusWhenReady);
    };
    requestAnimationFrame(focusWhenReady);
  }, []);

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
  const assignOwner = useMutation({
    mutationFn: (agentId: string) => goalsApi.assignOwner(goalId!, { agentId }),
    onSuccess: async () => {
      await invalidate();
      pushToast({ id: "goal-detail-operation", title: "Owner updated", tone: "success" });
    },
    onError: (error: Error) => pushToast({ title: error.message, tone: "error" }),
  });
  const uploadDescriptionImage = useMutation({
    mutationFn: async (file: File) => {
      if (!selectedOrganizationId) throw new Error("No organization selected");
      return assetsApi.uploadImage(selectedOrganizationId, file, `goals/${goalId}`);
    },
  });

  useEffect(() => {
    if (!goal) return;
    setTitleDraft(goal.title);
    setTitleEditing(false);
    setTitleError(null);
  }, [goal?.id]);

  useEffect(() => {
    if (titleEditing) titleInputRef.current?.focus();
  }, [titleEditing]);
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
      focusFeedbackComposer();
    },
    onError: (error: Error, feedback) => {
      setPendingFeedback({ ...feedback, status: "failed", error: error.message });
      focusFeedbackComposer();
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
    setRelatedExpanded(false);
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
  const conversationTimeline = useMemo(
    () => timeline.filter((entry) => entry.kind === "feedback"),
    [timeline],
  );
  const activityTimeline = useMemo(
    () => timeline.filter((entry) => entry.kind !== "feedback"),
    [timeline],
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
    const outcomeHeading = outcomeHeadingRef.current?.isConnected
      ? outcomeHeadingRef.current
      : null;
    const feedbackComposer = feedbackSurfaceRef.current;
    const goalTitle = goalTitleRef.current;
    const target = attentionHeading?.isConnected
      ? attentionHeading
      : feedbackComposer?.isConnected
          ? feedbackComposer
          : goalTitle?.isConnected
            ? goalTitle
            : outcomeHeading?.isConnected
              ? outcomeHeading
            : null;
    if (!target) return;
    if (target === feedbackComposer) focusFeedbackComposer();
    else target.focus();
    decisionFocusRequestRef.current = null;
  }, [
    changeDecision.isPending,
    changeProposals,
    focusFeedbackComposer,
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
  const hasActionableProposal = readyProposals.length > 0 || pendingChanges.length > 0;
  const hasAttention = Boolean(workspace.attention || readyProposals.length > 0 || pendingChanges.length > 0);
  const evaluationOutcome = readString(asRecord(goal.evaluationResult), "outcome");
  const showHeaderFacet = !["needs_attention", "needs_your_attention"].includes(workspace.facet);
  const progressProposal = acceptedProposal ?? readyProposals[0] ?? resultProposals[0] ?? null;
  const verifiedCriteriaCount = progressProposal?.criteria.filter((criterion) => criterion.status === "met").length ?? 0;
  const criteriaCount = goal.criteria?.length ?? 0;
  const verifiedCriteriaPercent = criteriaCount > 0
    ? Math.round((verifiedCriteriaCount / criteriaCount) * 100)
    : null;
  const linkedWorkCount = linkedProjects.length + linkedIssues.length;
  const activeIssueCount = linkedIssues.filter((issue) => !["done", "cancelled"].includes(issue.status)).length;
  const activeProjectCount = linkedProjects.filter((project) => !["completed", "cancelled", "archived"].includes(project.status)).length;
  const activeWorkCount = activeIssueCount + activeProjectCount;
  const targetDate = goal.evaluationDeadline ?? goal.actionDeadline ?? null;
  const waitingForAgentStart = isActive && workspace.facet === "waiting_focus";
  const nextStatusLabel = hasAttention
    ? "Review needed"
    : isClosed
      ? "Complete"
      : waitingForAgentStart
        ? "Ready to start"
        : goal.focus
          ? "Agent loop enabled"
          : "Ready for direction";
  const nextActionHeading = hasAttention
    ? "Review needed"
    : waitingForAgentStart
      ? "Owner ready"
      : goal.focus
        ? "Waiting for progress"
        : "Give the Agent direction";

  const beginTitleEdit = () => {
    setTitleDraft(goal.title);
    setTitleError(null);
    setTitleEditing(true);
  };
  const cancelTitleEdit = () => {
    setTitleDraft(goal.title);
    setTitleError(null);
    setTitleEditing(false);
  };
  const saveTitle = async () => {
    const title = titleDraft.trim();
    if (!title) {
      setTitleError("Goal title cannot be empty.");
      titleInputRef.current?.focus();
      return;
    }
    if (title === goal.title) {
      cancelTitleEdit();
      return;
    }
    setTitleError(null);
    try {
      await updateGoal.mutateAsync({ title });
      setTitleDraft(title);
      setTitleEditing(false);
    } catch (error) {
      setTitleError(error instanceof Error ? error.message : "Goal title could not be saved.");
      requestAnimationFrame(() => titleInputRef.current?.focus());
    }
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
    targetTime: goal.evaluationDeadline ? toDateOnlyValue(goal.evaluationDeadline) : "",
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
  const resultKey = (proposalId: string, decision: "accept" | "reject", feedback = "") => {
    const identity = `${proposalId}:${decision}:${feedback.trim()}`;
    const existing = resultRequestKeysRef.current.get(identity);
    if (existing) return existing;
    const key = crypto.randomUUID();
    resultRequestKeysRef.current.set(identity, key);
    return key;
  };
  const selectTab = (value: string) => {
    if (!GOAL_DETAIL_TABS.includes(value as GoalDetailTab)) return;
    const nextTab = value as GoalDetailTab;
    const params = new URLSearchParams(location.search);
    if (nextTab === "conversation") params.delete("tab");
    else params.set("tab", nextTab);
    const nextSearch = params.toString();
    navigate({
      pathname: location.pathname,
      search: nextSearch ? `?${nextSearch}` : "",
      hash: location.hash,
    }, { replace: true });
  };
  const copyGoalId = async () => {
    await navigator.clipboard?.writeText(goal.id);
    setCopiedGoalId(true);
    pushToast({ title: "Copied Goal ID", tone: "success" });
    setTimeout(() => setCopiedGoalId(false), 1500);
  };
  const openGoalChat = () => {
    const restored = storedGoalChatTarget(goal.orgId, goal.id);
    sidePanel.openTarget({
      kind: "goal_chat",
      organizationId: goal.orgId,
      goalId: goal.id,
      agentId: goal.ownerAgentId ?? null,
      conversationId: restored?.conversationId ?? null,
      clientMutationId: restored?.clientMutationId ?? crypto.randomUUID(),
      body: restored?.body ?? "",
      label: goal.title,
    });
  };
  const renderTimelineEntries = (
    entries: TimelineView[],
    options: { comments: boolean; emptyMessage: string; includePending?: boolean },
  ) => (
    <div className={cn("min-w-0", options.comments ? "space-y-3" : "divide-y divide-border border-y border-border")}>
      {entries.length === 0 && !(options.includePending && pendingFeedback) ? (
        <p className="py-6 text-center text-sm text-muted-foreground">{options.emptyMessage}</p>
      ) : null}
      {entries.map((entry) => {
        const entryKey = `${entry.kind}:${entry.id}`;
        const receivesHistoryFocus = entryKey === historyFocusKey;
        const actorLabel = entry.actorType === "user" && entry.actorId && entry.actorId === sessionQuery.data?.user.id
          ? "You"
          : entry.actorName ?? timelineKindLabel(entry.kind);
        const content = (
          <>
            {entry.kind === "result_proposal" && entry.status ? (
              <div className="mb-1 text-xs font-medium text-muted-foreground">
                {resultProposalHistoryLabel(entry.status)}
              </div>
            ) : null}
            {entry.kind === "feedback" ? (
              <MarkdownBody className="min-w-0 break-words text-sm leading-6 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
                {entry.summary}
              </MarkdownBody>
            ) : (
              <p className="min-w-0 whitespace-pre-wrap break-words text-sm leading-6">{entry.summary}</p>
            )}
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
          </>
        );
        if (options.comments) {
          return (
            <div key={entryKey} className="grid min-w-0 grid-cols-[2rem_minmax(0,1fr)] gap-2.5">
              <div className="relative z-10 flex h-8 w-8 items-center justify-center rounded-full border border-border bg-background text-xs font-semibold text-muted-foreground">
                {actorLabel.slice(0, 1).toUpperCase()}
              </div>
              <article
                ref={receivesHistoryFocus ? historyFocusRef : undefined}
                tabIndex={receivesHistoryFocus ? -1 : undefined}
                className="min-w-0 overflow-hidden rounded-md border border-border bg-background outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <header className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/25 px-3 py-2">
                  <span className="min-w-0 break-words text-xs font-medium">{actorLabel}</span>
                  {entry.createdAt ? <span className="shrink-0 text-xs text-muted-foreground">{formatDate(entry.createdAt)}</span> : null}
                </header>
                <div className="min-w-0 px-3 py-3">{content}</div>
              </article>
            </div>
          );
        }
        return (
          <div
            key={entryKey}
            ref={receivesHistoryFocus ? historyFocusRef : undefined}
            tabIndex={receivesHistoryFocus ? -1 : undefined}
            className="grid min-w-0 gap-2 rounded-sm py-3 outline-none focus-visible:ring-2 focus-visible:ring-ring sm:grid-cols-[9rem_minmax(0,1fr)_auto]"
          >
            <span className="min-w-0 break-words text-xs font-medium text-muted-foreground">{actorLabel}</span>
            <div className="min-w-0">{content}</div>
            {entry.createdAt ? <span className="shrink-0 text-xs text-muted-foreground">{formatDate(entry.createdAt)}</span> : null}
          </div>
        );
      })}
      {options.includePending && pendingFeedback ? (
        <div className="grid min-w-0 grid-cols-[2rem_minmax(0,1fr)] gap-2.5">
          <div className="relative z-10 flex h-8 w-8 items-center justify-center rounded-full border border-border bg-background text-xs font-semibold">Y</div>
          <article className={cn("min-w-0 overflow-hidden rounded-md border bg-background", pendingFeedback.status === "failed" ? "border-destructive/50" : "border-border")}>
            <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/25 px-3 py-2">
              <span className="text-xs font-medium">You</span>
              <span className={cn("text-xs text-muted-foreground", pendingFeedback.status === "failed" && "text-destructive")}>
                {pendingFeedback.status === "sending" ? "Posting..." : "Not posted"}
              </span>
            </header>
            <div className="space-y-2 px-3 py-3">
              <MarkdownBody className="min-w-0 break-words text-sm leading-6 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
                {pendingFeedback.body}
              </MarkdownBody>
              {pendingFeedback.attachments.length > 0 ? (
                <div aria-label="Pending feedback attachments" className="flex min-w-0 flex-wrap gap-2">
                  {pendingFeedback.attachments.map((attachment) => (
                    <span key={attachment.uri} className="inline-flex max-w-full min-w-0 items-center gap-1 text-xs text-muted-foreground">
                      <Paperclip className="h-3.5 w-3.5 shrink-0" />
                      <span className="break-all">{attachment.name}</span>
                    </span>
                  ))}
                </div>
              ) : null}
              {pendingFeedback.error ? <p role="alert" className="text-xs text-destructive">{pendingFeedback.error}</p> : null}
              {pendingFeedback.status === "failed" ? (
                <Button type="button" size="sm" variant="outline" onClick={() => feedbackMutation.mutate(pendingFeedback)}>Retry comment</Button>
              ) : null}
            </div>
          </article>
        </div>
      ) : null}
    </div>
  );
  const historyPagination = historyCursor ? (
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
  ) : null;
  const diagnostics = debugMode ? (
    <Section title="Goal diagnostics" icon={ShieldCheck}>
      <pre className="max-w-full overflow-x-auto whitespace-pre-wrap break-words border border-border bg-muted/20 p-3 text-xs leading-5">{JSON.stringify(workspace, null, 2)}</pre>
    </Section>
  ) : null;
  const renderGoalProperties = (inline = false) => {
    const ownerOpen = inline ? mobileOwnerOpen : desktopOwnerOpen;
    const ownerSearch = inline ? mobileOwnerSearch : desktopOwnerSearch;
    const setOwnerOpen = inline ? setMobileOwnerOpen : setDesktopOwnerOpen;
    const setOwnerSearch = inline ? setMobileOwnerSearch : setDesktopOwnerSearch;
    const ownerOptions = (agentsQuery.data ?? [])
      .filter((agent) => agent.status !== "terminated" && agent.status !== "pending_approval")
      .filter((agent) => {
        const query = ownerSearch.trim().toLowerCase();
        return !query || `${agent.name} ${agent.title ?? ""} ${agent.role}`.toLowerCase().includes(query);
      });

    return (
    <div className="space-y-1">
      {isClosed ? (
        <PropertyRow label="Owner" align="start">
          {owner ? (
            <AgentIdentity
              name={owner.name}
              icon={owner.icon}
              role={owner.role}
              className="max-w-full min-w-0 px-1 py-1 font-medium"
            />
          ) : (
            <span className="px-1 py-1 text-sm text-muted-foreground">{goal.ownerAgentId ? "Owner unavailable" : "Unassigned"}</span>
          )}
        </PropertyRow>
      ) : (
        <PropertyPicker
          inline={inline}
          label="Owner"
          open={ownerOpen}
          onOpenChange={(open) => { setOwnerOpen(open); if (!open) setOwnerSearch(""); }}
          triggerContent={owner ? (
            <AgentIdentity name={owner.name} icon={owner.icon} role={owner.role} className="w-full" />
          ) : (
            <span className="text-sm text-muted-foreground">{goal.ownerAgentId ? "Owner unavailable" : "Unassigned"}</span>
          )}
          triggerAriaLabel="Change Goal owner"
          triggerClassName="min-w-0 w-full max-w-full flex-1 justify-start overflow-hidden border-transparent bg-transparent px-1 py-1 hover:bg-accent/40"
          popoverClassName={inline ? "w-full" : "w-[19rem]"}
          popoverAlign="start"
          rowAlign="start"
          extra={owner && orgId && supportsIssueRuntimeOverrides(owner) ? (
            <IssueRuntimeSelector
              agent={owner}
              orgId={orgId}
              overrides={goal.ownerAgentRuntimeOverrides}
              variant="icon"
              disabled={updateGoal.isPending || assignOwner.isPending}
              onApply={(ownerAgentRuntimeOverrides) => updateGoal.mutate({ ownerAgentRuntimeOverrides })}
            />
          ) : null}
        >
          <input
            className="w-full px-2 py-1.5 text-xs bg-transparent outline-none border-b border-border mb-1 placeholder:text-muted-foreground/50"
            placeholder="Search Agents..."
            value={ownerSearch}
            onChange={(event) => setOwnerSearch(event.target.value)}
            autoFocus={!inline}
          />
          <div className="scrollbar-auto-hide max-h-60 overflow-y-auto overscroll-contain">
            {isDraft ? (
              <button
                type="button"
                className={cn("flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent/50", !goal.ownerAgentId && "bg-accent")}
                onClick={() => { updateGoal.mutate({ ownerAgentId: null }); setOwnerOpen(false); }}
              >
                <span className="text-sm text-muted-foreground">Unassigned</span>
              </button>
            ) : (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">Keep current owner</div>
            )}
            {ownerOptions.length === 0 ? (
              <p className="px-2 py-2 text-xs text-muted-foreground">{agentsQuery.isError ? "Agents could not be loaded." : "No available Agents."}</p>
            ) : ownerOptions.map((agent) => (
              <button
                type="button"
                data-inline-entity-option
                key={agent.id}
                role="option"
                aria-selected={agent.id === goal.ownerAgentId}
                className={cn("flex w-full items-center gap-2 rounded px-2 py-2 text-left text-xs hover:bg-accent/50", agent.id === goal.ownerAgentId && "bg-accent")}
                onClick={() => {
                  if (isDraft) updateGoal.mutate({ ownerAgentId: agent.id });
                  else assignOwner.mutate(agent.id);
                  setOwnerOpen(false);
                }}
              >
                <span className="flex min-w-0 flex-1"><AgentMenuLabel agent={agent} agentAvatarStyle="bare" /></span>
                {agent.id === goal.ownerAgentId ? <Check className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : null}
              </button>
            ))}
          </div>
        </PropertyPicker>
      )}

      <PropertyRow label="Agent work">
        <span className="inline-flex items-center gap-1.5 px-1 py-1 text-sm text-muted-foreground">
          <Focus className="h-3.5 w-3.5" />
          {isActive ? (goal.focus ? "Focused" : "On demand") : isDraft ? "Starts with Goal" : "Stopped"}
          {isActive ? (
            <span className="sr-only">
              {goal.focus
                ? "This Goal stays eligible for the Owner Agent's next run."
                : "The Owner Agent responds to new direction or linked work."}
            </span>
          ) : null}
        </span>
      </PropertyRow>

      <PropertyRow label="Active work" align="start">
        {linkedWorkCount > 0 ? (
          <div className="flex flex-wrap gap-2">
            <span className="rounded-md bg-muted px-2 py-1 text-xs font-medium tabular-nums">{activeWorkCount} active</span>
            <span className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground tabular-nums">{linkedWorkCount} linked</span>
          </div>
        ) : <p className="text-sm text-muted-foreground">No linked work yet.</p>}
      </PropertyRow>

      <PropertyRow label="Status">
        <StatusIcon
          status={goalStatusIconStatus[goal.status] ?? "todo"}
          label={goalStatusLabel(goal.status)}
          showLabel
        />
      </PropertyRow>

      <PropertyRow label="Target">
        {isDraft ? (
          <GoalTargetTimePicker
            value={goal.evaluationDeadline || goal.actionDeadline
              ? toDateOnlyValue(goal.evaluationDeadline ?? goal.actionDeadline!)
              : ""}
            onChange={(targetDate) => updateGoal.mutate({ targetTime: targetDate || null })}
          />
        ) : (
          <span className="inline-flex min-w-0 items-center gap-1.5 px-1 py-1 text-sm">
            <CalendarDays className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">
              {goal.evaluationDeadline || goal.actionDeadline
                ? formatDateOnly(goal.evaluationDeadline ?? goal.actionDeadline!)
                : "Not set"}
            </span>
          </span>
        )}
      </PropertyRow>

      {goal.criteria.length > 0 ? (
        <div className="min-w-0 border-t border-border py-3">
          <div className="mb-1 flex items-center justify-between gap-2 text-xs font-medium text-muted-foreground">
            <span>Success criteria</span>
            <Target className="h-3.5 w-3.5" />
          </div>
          <div className="divide-y divide-border">
            {goal.criteria.slice(0, 3).map((criterion) => (
              <p key={criterion.id} className="min-w-0 whitespace-pre-wrap break-words py-2 text-sm leading-5">{criterion.label}</p>
            ))}
          </div>
          {goal.criteria.length > 3 ? <p className="pt-1 text-xs text-muted-foreground">+{goal.criteria.length - 3} more in Evidence</p> : null}
        </div>
      ) : null}

      {linkedWorkCount > 0 ? (
        <div className="min-w-0 border-t border-border pt-3">
          <div className="mb-1 flex items-center justify-between gap-2 text-xs font-medium text-muted-foreground">
            <span>Related</span>
            <ArrowRight className="h-3.5 w-3.5" />
          </div>
          <WorkLinks projects={linkedProjects} issues={linkedIssues} limit={relatedExpanded ? undefined : 3} />
          {linkedWorkCount > 3 ? (
            <button
              type="button"
              className="mt-1 w-full rounded-md px-2 py-1.5 text-left text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-expanded={relatedExpanded}
              onClick={() => setRelatedExpanded((current) => !current)}
            >
              {relatedExpanded ? "Show fewer" : `Show ${linkedWorkCount - 3} more`}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
    );
  };

  return (
    <div data-testid="goal-detail-workspace" className="issue-detail-container min-h-0 w-full min-w-0 pb-[calc(5rem+env(safe-area-inset-bottom))] md:pb-8">
      <div className="issue-detail-layout goal-detail-layout mx-auto max-w-6xl">
      <header className="issue-detail-heading min-w-0 space-y-3">
        <div className="flex min-w-0 flex-col items-stretch gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1">
            {isDraft && titleEditing ? (
              <div className="min-w-0 space-y-2" data-testid="goal-title-editor" data-detail-escape-layer="true">
                <div className="flex min-w-0 items-start gap-2">
                  <input
                    ref={titleInputRef}
                    aria-label="Goal title"
                    value={titleDraft}
                    onChange={(event) => {
                      setTitleDraft(event.target.value);
                      setTitleError(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        event.stopPropagation();
                        void saveTitle();
                      } else if (event.key === "Escape") {
                        event.preventDefault();
                        event.stopPropagation();
                        cancelTitleEdit();
                      }
                    }}
                    disabled={updateGoal.isPending}
                    className="h-10 min-w-0 flex-1 rounded-md border border-border bg-background px-3 text-xl font-semibold outline-none focus:border-ring"
                  />
                  <Button type="button" size="icon-sm" aria-label="Save Goal title" title="Save title" onClick={() => void saveTitle()} disabled={updateGoal.isPending}>
                    {updateGoal.isPending ? <Clock3 className="h-4 w-4" /> : <Check className="h-4 w-4" />}
                  </Button>
                  <Button type="button" size="icon-sm" variant="outline" aria-label="Cancel Goal title edit" title="Cancel" onClick={cancelTitleEdit} disabled={updateGoal.isPending}>
                    <X className="h-4 w-4" />
                  </Button>
                </div>
                {titleError ? <p role="alert" className="text-sm text-destructive">{titleError}</p> : null}
              </div>
            ) : (
              <div className="flex min-w-0 items-start gap-2">
                <h1 ref={goalTitleRef} tabIndex={-1} className="min-w-0 flex-1 whitespace-normal break-words rounded-sm text-2xl font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring">{goal.title}</h1>
                {isDraft ? (
                  <Button type="button" size="icon-sm" variant="ghost" aria-label="Edit Goal title" title="Edit title" onClick={beginTitleEdit}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                ) : null}
              </div>
            )}
          </div>
          <div className="flex w-full shrink-0 flex-wrap items-center justify-end gap-2 sm:w-auto">
            {isDraft ? <Button size="sm" className="h-9 rounded-lg" onClick={continueAlignment}><Target className="mr-1.5 h-4 w-4" />Continue Goal</Button> : null}
            <div className="flex h-9 items-center gap-0.5 rounded-lg border border-border bg-background/80 p-1">
              {!isDraft ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 w-7 rounded-md px-0 text-xs sm:w-auto sm:px-2.5"
                aria-label={copiedGoalId ? "Copied" : "Copy ID"}
                onClick={() => void copyGoalId()}
              >
                {copiedGoalId ? <Check className="h-4 w-4 sm:mr-1.5" /> : <Copy className="h-4 w-4 sm:mr-1.5" />}
                <span className="hidden sm:inline">{copiedGoalId ? "Copied" : "Copy ID"}</span>
              </Button>
              ) : null}
              {!isDraft ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 w-7 rounded-md px-0 text-xs sm:w-auto sm:px-2.5"
                aria-label="Chat"
                onClick={openGoalChat}
              >
                <MessageSquare className="h-4 w-4 sm:mr-1.5" /><span className="hidden sm:inline">Chat</span>
              </Button>
              ) : null}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="ghost" size="icon-sm" className="h-7 w-7 rounded-md" aria-label="More Goal actions" title="More actions">
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <DropdownMenuItem onSelect={() => void copyGoalId()}>
                    <Copy className="h-4 w-4" />Copy Goal ID
                  </DropdownMenuItem>
                  {isDraft ? (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => void remove()}>
                        <Trash2 className="h-4 w-4" />Delete Goal
                      </DropdownMenuItem>
                    </>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
              <PropertiesManifestTrigger
                className="md:hidden"
                onClick={() => setMobilePropsOpen(true)}
              />
            </div>
          </div>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted-foreground">
          <StatusBadge status={lifecycle} />
          {!isDraft && showHeaderFacet ? <span>{facetLabel(workspace.facet)}</span> : null}
          {!isDraft && owner ? (
            <div className="min-w-0 max-w-full">
              <AgentIdentity
                name={owner.name}
                icon={owner.icon}
                role={owner.role}
                size="sm"
                className="min-w-0 max-w-full [&>span:last-child]:min-w-0 [&>span:last-child]:whitespace-normal [&>span:last-child]:break-all"
              />
            </div>
          ) : null}
          {!isDraft && targetDate ? <span>due {formatDateOnly(targetDate)}</span> : null}
        </div>
      </header>

      {isDraft ? (
        <div className="issue-detail-body min-w-0 space-y-5">
          <InlineEditor
            value={goal.description ?? ""}
            onSave={(description) => updateGoal.mutateAsync({ description: markdownDocumentOrNull(description) })}
            as="p"
            className="min-h-0 min-w-0 whitespace-pre-wrap break-words text-[15px] leading-7 text-foreground"
            placeholder="Add a description..."
            multiline
            editorEngine="codemirror"
            documentIdentity={`goal:${goal.id}`}
            variant="issue-description"
            imageUploadHandler={async (file) => {
              const asset = await uploadDescriptionImage.mutateAsync(file);
              return asset.contentPath;
            }}
          />
          {diagnostics}
        </div>
      ) : (
      <>
        <main className="issue-detail-body min-w-0 space-y-5">
          <MarkdownBody className="min-w-0 break-words text-[15px] leading-7 text-foreground [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
            {goal.description ?? currentGoalSummary}
          </MarkdownBody>

          {!isDraft ? <section aria-label="Goal progress" className="grid min-w-0 gap-4 border-y border-border py-4 sm:grid-cols-[minmax(0,1fr)_9rem_10rem]">
            <div className="min-w-0 sm:pr-4">
              <span className="text-xs text-muted-foreground">Latest progress</span>
              <p className="mt-1 line-clamp-2 min-w-0 break-words text-sm leading-5">{workspace.currentProgress.summary}</p>
            </div>
            <div className="min-w-0 border-t border-border pt-3 sm:border-l sm:border-t-0 sm:pl-4 sm:pt-0">
              <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>Criteria verified</span>
                {verifiedCriteriaPercent !== null ? <span className="tabular-nums">{verifiedCriteriaPercent}%</span> : null}
              </div>
              <strong className="mt-1 block text-sm font-semibold tabular-nums">{criteriaCount > 0 ? `${verifiedCriteriaCount} / ${criteriaCount}` : "Not defined"}</strong>
              {verifiedCriteriaPercent !== null ? (
                <div className="mt-2 h-1.5 overflow-hidden rounded-sm bg-muted" aria-label={`${verifiedCriteriaPercent}% of success criteria verified`}>
                  <div className="h-full bg-[color:var(--accent-base)] transition-[width]" style={{ width: `${verifiedCriteriaPercent}%` }} />
                </div>
              ) : null}
            </div>
            <div className="min-w-0 border-t border-border pt-3 sm:border-l sm:border-t-0 sm:pl-4 sm:pt-0">
              <span className="text-xs text-muted-foreground">Next</span>
              <strong className={cn("mt-1 block line-clamp-2 text-sm font-semibold", hasAttention && "text-amber-700 dark:text-amber-400")}>
                {nextStatusLabel}
              </strong>
            </div>
          </section> : null}

          {!isDraft && !isClosed ? (
            <section aria-label="Next Goal action" className={cn(
              "flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3",
              hasAttention ? "border-amber-500/35 bg-amber-500/5" : "border-border bg-muted/20",
            )}>
              <div className="min-w-0">
                <p className="text-sm font-semibold">{nextActionHeading}</p>
                <p className="mt-0.5 min-w-0 break-words text-xs leading-5 text-muted-foreground">
                  {hasAttention
                    ? "Review the latest Goal update below."
                    : waitingForAgentStart
                      ? `${owner?.name ?? "The Owner Agent"} is ready to begin the next action.`
                      : goal.focus
                        ? `Rudder will keep this Goal eligible for ${owner?.name ?? "the Owner Agent"} and report new evidence here.`
                        : "Send direction to the Owner Agent without leaving this Goal."}
                </p>
              </div>
              {!goal.focus && !hasAttention ? (
                <Button ref={focusButtonRef} type="button" size="sm" onClick={() => setFocus.mutate(true)} disabled={setFocus.isPending}>
                  <Sparkles className="h-4 w-4" />{setFocus.isPending && setFocus.variables === true ? "Starting..." : "Start Agent work"}
                </Button>
              ) : goal.focus && !hasAttention ? (
                <Button ref={focusButtonRef} type="button" size="sm" variant="outline" onClick={() => setFocus.mutate(false)} disabled={setFocus.isPending}>
                  <Focus className="h-4 w-4" />{setFocus.isPending && setFocus.variables === false ? "Pausing..." : "Pause Agent work"}
                </Button>
              ) : null}
            </section>
          ) : null}

          <section aria-label="Goal overview" className="min-w-0 space-y-5">
          {isDraft ? (
            <Section title="Before work starts" icon={Target} headingRef={outcomeHeadingRef}>
              <p className="min-w-0 whitespace-pre-wrap break-words text-sm leading-6">
                {workspace.attention?.reason ?? "Clarify the result and confirm an Owner Agent before starting this Goal."}
              </p>
              <p className="text-xs text-muted-foreground">Next step: continue this Goal, complete the visible requirements, then confirm the start preview.</p>
            </Section>
          ) : (
            <>
              <Section title="Outcome" icon={Target} headingRef={outcomeHeadingRef}>
                <p className="min-w-0 whitespace-pre-wrap break-words text-sm leading-6">{currentGoalSummary}</p>
                {currentGoalRecord.updatedFromEvidence === true ? <p className="text-xs text-muted-foreground">Updated from evidence and feedback</p> : null}
              </Section>
              <Section title="Work" icon={Sparkles}>
                  <div className="divide-y divide-border border-y border-border">
                    <div className="grid min-w-0 gap-1 py-3 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-3">
                      <div className="text-xs font-medium text-muted-foreground">Current progress</div>
                      <div className="min-w-0">
                        <p className="whitespace-pre-wrap break-words text-sm leading-6">{workspace.currentProgress.summary}</p>
                        {workspace.currentProgress.uncertainty ? <p className="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground">{workspace.currentProgress.uncertainty}</p> : null}
                        <EvidenceList items={workspace.currentProgress.evidence ?? []} refs={[]} context={evidenceContext} />
                      </div>
                    </div>
                    {!isClosed && workspace.agentAction ? (
                      <div className="grid min-w-0 gap-1 py-3 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-3">
                        <div className="text-xs font-medium text-muted-foreground">{agentActionHeading}</div>
                        <p className="min-w-0 whitespace-pre-wrap break-words text-sm leading-6">{agentAction}</p>
                      </div>
                    ) : null}
                    {!isClosed ? <div className="grid min-w-0 gap-1 py-3 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-3">
                      <div className="text-xs font-medium text-muted-foreground">Next step</div>
                      <div className="min-w-0">
                        <p className="whitespace-pre-wrap break-words text-sm leading-6">{nextStep}</p>
                        {wakeCondition ? <p className="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground">Resume when: {wakeCondition}</p> : null}
                      </div>
                    </div> : null}
                  </div>
                </Section>
            </>
          )}
          </section>

      <section aria-label="Activity" className="min-w-0 space-y-3">
        <Tabs value={activeTab} onValueChange={selectTab} className="min-w-0 space-y-3">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 border-b border-border pb-2">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <ActivityIcon className="h-3.5 w-3.5 text-muted-foreground" />
              <span>Activity</span>
            </div>
            <TabsList className="h-8 rounded-md p-0.5" aria-label="Goal activity views">
              <TabsTrigger value="conversation" className="h-7 rounded px-2.5 text-xs">
                <MessageSquareText className="h-3.5 w-3.5" />Conversation
                {conversationTimeline.length > 0 ? <span className="rounded-sm bg-background/70 px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">{conversationTimeline.length}</span> : null}
              </TabsTrigger>
              <TabsTrigger value="activity" className="h-7 rounded px-2.5 text-xs">
                <ActivityIcon className="h-3.5 w-3.5" />Activity
                {activityTimeline.length > 0 ? <span className="rounded-sm bg-background/70 px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">{activityTimeline.length}</span> : null}
              </TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="conversation" className="m-0 min-w-0 space-y-5">

      {!isClosed && !isDraft && hasAttention ? (
        <Section title="Action needed" icon={ShieldCheck} headingRef={attentionHeadingRef}>
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

      <Section title="Comments" icon={History}>
        <div className="relative min-w-0 before:absolute before:bottom-0 before:left-4 before:top-0 before:w-px before:bg-border">
          {renderTimelineEntries(conversationTimeline, {
            comments: true,
            emptyMessage: isDraft ? "No comments while this Goal is being aligned." : "No comments yet.",
            includePending: isActive,
          })}
        </div>
        {historyPagination}
      </Section>

      {isActive && !hasActionableProposal ? (
        <CommentComposer
          body={feedbackBody}
          onBodyChange={(body) => {
            feedbackMutation.reset();
            setFeedbackBody(body);
          }}
          onSubmit={submitFeedback}
          canSubmit={Boolean(feedbackBody.trim()) && !feedbackMutation.isPending && !feedbackAttachmentMutation.isPending}
          submitting={feedbackMutation.isPending}
          editorRef={feedbackRef}
          surfaceRef={feedbackSurfaceRef}
          ariaLabel="Goal comment composer"
          editorAriaLabel="Goal comment"
          detailEscapeLayer
          attachmentAccept="image/*"
          attachmentAriaLabel="Attach comment image"
          attachmentMultiple={false}
          imageUploadHandler={async (file) => {
            const asset = await feedbackAttachmentMutation.mutateAsync({ file });
            return asset.contentPath;
          }}
          onAttachmentError={(error, file) => {
            setFeedbackAttachmentError(error.message);
            setFailedFeedbackFile(file);
          }}
          attachmentStatus={feedbackAttachmentError ? (
            <div className="flex flex-wrap items-center gap-2 text-xs text-destructive">
              <span role="alert">{feedbackAttachmentError}</span>
              {failedFeedbackFile ? (
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto p-0 text-xs"
                  onClick={() => {
                    const file = failedFeedbackFile;
                    void feedbackAttachmentMutation.mutateAsync({ file }).then((asset) => {
                      const safeName = file.name.replace(/[[\]]/g, "\\$&");
                      setFeedbackBody((current) => current
                        ? `${current}\n\n![${safeName}](${asset.contentPath})`
                        : `![${safeName}](${asset.contentPath})`);
                      focusFeedbackComposer();
                    }).catch(() => undefined);
                  }}
                  disabled={feedbackAttachmentMutation.isPending}
                >
                  Retry attachment
                </Button>
              ) : null}
            </div>
          ) : null}
        />
      ) : (
        <p className="border-t border-border pt-4 text-sm text-muted-foreground">
          {isDraft
            ? "Comments become available after this Goal starts."
            : hasActionableProposal
              ? "Resolve the review above before adding another comment."
              : "This conversation is read-only because the Goal is closed."}
        </p>
      )}
          </TabsContent>

          <TabsContent value="activity" className="m-0 min-w-0 space-y-4">
            <div className="flex min-w-0 items-end justify-between gap-3 border-b border-border pb-3">
              <div className="min-w-0">
                <h2 className="text-base font-semibold">Goal activity</h2>
                <p className="mt-1 text-sm text-muted-foreground">{activityTimeline.length} recorded update{activityTimeline.length === 1 ? "" : "s"}</p>
              </div>
            </div>
            {renderTimelineEntries(activityTimeline, { comments: false, emptyMessage: "No Goal activity yet." })}
            {historyPagination}
          </TabsContent>
        </Tabs>
      </section>

      <section aria-label="Goal evidence" className="min-w-0 space-y-5">
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
        <Section title="Success criteria" icon={Target}>
          {goal.criteria && goal.criteria.length > 0 ? (
            <div className="divide-y divide-border border-y border-border">
              {goal.criteria.map((criterion) => {
                const resultCriterion = progressProposal?.criteria.find((candidate) => candidate.label === criterion.label);
                return (
                  <div key={criterion.id} className="flex min-w-0 items-start justify-between gap-3 py-2.5 text-sm">
                    <span className="min-w-0 break-words">{criterion.label}</span>
                    <span className={cn(
                      "shrink-0 text-xs font-medium",
                      resultCriterion?.status === "met" && "text-emerald-700 dark:text-emerald-400",
                      (resultCriterion?.status === "unmet" || resultCriterion?.status === "breached") && "text-destructive",
                      (!resultCriterion || resultCriterion.status === "unknown") && "text-muted-foreground",
                    )}>
                      {resultCriterion?.statusLabel ?? "Not verified"}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : <p className="text-sm text-muted-foreground">No success criteria defined.</p>}
        </Section>
        <Section title="Current evidence" icon={FileCheck2}>
          <EvidenceList items={workspace.currentProgress.evidence ?? []} refs={[]} context={evidenceContext} />
          {(workspace.currentProgress.evidence ?? []).length === 0 ? <p className="text-sm text-muted-foreground">No current progress evidence attached.</p> : null}
        </Section>
        {resultProposals.length > 0 ? (
          <Section title="Result evidence" icon={ShieldCheck}>
            <div className="space-y-4">
              {resultProposals.map((proposal) => (
                <article key={proposal.id} className="min-w-0 border-l-2 border-border pl-3">
                  <div className="text-xs font-medium text-muted-foreground">{resultProposalHistoryLabel(proposal.status)}</div>
                  <ResultProposalSummary proposal={proposal} accepted={proposal.status === "accepted"} />
                </article>
              ))}
            </div>
          </Section>
        ) : null}
      </section>
      {diagnostics}

        </main>

        <aside className="issue-detail-rail min-w-0">
          <PropertiesManifest ariaLabel="Goal properties">
            {renderGoalProperties()}
          </PropertiesManifest>
        </aside>
      </>
      )}
      </div>
      <PropertiesManifestSheet
        open={mobilePropsOpen}
        onOpenChange={(open) => {
          setMobilePropsOpen(open);
          if (!open) {
            setMobileOwnerOpen(false);
            setMobileOwnerSearch("");
          }
        }}
      >
        {renderGoalProperties(true)}
      </PropertiesManifestSheet>
    </div>
  );
}
