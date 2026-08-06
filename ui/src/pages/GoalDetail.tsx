import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Link, useLocation, useNavigate, useParams } from "@/lib/router";
import type { GoalDependencies, GoalWorkspaceFacet, Issue, Project } from "@rudderhq/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Check,
  CircleDot,
  Clock3,
  FileCheck2,
  Focus,
  History,
  MessageSquareText,
  Pencil,
  ShieldCheck,
  Sparkles,
  Target,
  Trash2,
  UserRound,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { agentsApi } from "../api/agents";
import { goalsApi } from "../api/goals";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
import { InlineEditor } from "../components/InlineEditor";
import { PageSkeleton } from "../components/PageSkeleton";
import { StatusBadge } from "../components/StatusBadge";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useDialog } from "../context/DialogContext";
import { useOrganization } from "../context/OrganizationContext";
import { usePanel } from "../context/PanelContext";
import { useToast } from "../context/ToastContext";
import { markdownDocumentOrNull } from "../lib/markdown-document-value";
import { queryKeys } from "../lib/queryKeys";
import { cn, formatDate, issueUrl, projectUrl } from "../lib/utils";

type TimelineView = {
  id: string;
  kind: string;
  summary: string;
  createdAt: Date | string | null;
  evidenceRefs: string[];
  actorName: string | null;
};

type ChangeProposalView = {
  id: string;
  status: string;
  before: string;
  after: string;
  rationale: string | null;
  impact: string | null;
  evidenceRefs: string[];
};

type ResultProposalView = {
  id: string;
  status: string;
  outcome: string;
  risks: string | null;
  evidenceRefs: string[];
  gaps: string[];
};

type PendingFeedback = {
  identity: string;
  idempotencyKey: string;
  body: string;
  feedbackKind: "ordinary" | "consequential";
  status: "sending" | "failed";
  error: string | null;
};

type ResultDecisionInput = {
  id: string;
  decision: "accept" | "reject";
  feedback?: string;
  idempotencyKey: string;
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
  const parts = [
    direct ? `Outcome: ${direct}` : null,
    labels.length > 0 ? `Success: ${labels.join("; ")}` : null,
    target ? `Target time: ${target}` : null,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join("\n") : Object.keys(record).length === 0 ? "Not provided" : "The Goal direction would change.";
}

function normalizeTimeline(value: unknown): TimelineView[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    const id = readString(record, "id");
    const summary = readString(record, "summary", "body");
    if (!id || !summary) return [];
    const createdAt = record.createdAt ?? record.occurredAt ?? null;
    return [{
      id,
      kind: readString(record, "kind", "activityKind", "feedbackKind") ?? "update",
      summary,
      createdAt: typeof createdAt === "string" || createdAt instanceof Date ? createdAt : null,
      evidenceRefs: readStringArray(record.evidenceRefs),
      actorName: readString(record, "actorName", "submittedByName"),
    }];
  });
}

function normalizeChangeProposals(value: unknown): ChangeProposalView[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    const id = readString(record, "id");
    if (!id) return [];
    return [{
      id,
      status: readString(record, "status") ?? "pending",
      before: summarizeValue(record.beforeSummary ?? record.before ?? record.beforeSnapshot ?? record.beforeContract),
      after: summarizeValue(record.afterSummary ?? record.after ?? record.afterContract ?? record.afterPatch),
      rationale: readString(record, "rationale", "reason"),
      impact: readString(record, "impact", "impactSummary"),
      evidenceRefs: readStringArray(record.evidenceRefs),
    }];
  });
}

function normalizeResultProposals(value: unknown): ResultProposalView[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    const id = readString(record, "id");
    if (!id) return [];
    const preflight = asRecord(record.preflight);
    const candidate = asRecord(record.candidate);
    const criteria = Array.isArray(preflight.criteria) ? preflight.criteria : [];
    const gaps = criteria.flatMap((criterion) => {
      const criterionRecord = asRecord(criterion);
      const missingEvidence = readStringArray(criterionRecord.missingEvidence);
      if (missingEvidence.length > 0) return missingEvidence;
      if (criterionRecord.status === "unknown") {
        const criterionId = readString(criterionRecord, "id");
        return criterionId ? [`${criterionId} remains unknown`] : ["A success judgment remains unknown"];
      }
      return [];
    });
    return [{
      id,
      status: readString(record, "status") ?? "ready",
      outcome: readString(record, "outcomeSummary", "summary")
        ?? readString(preflight, "outcome")
        ?? "The Agent has proposed a terminal result.",
      risks: readString(record, "riskSummary", "risks"),
      evidenceRefs: readStringArray(record.evidenceRefs).length > 0
        ? readStringArray(record.evidenceRefs)
        : readStringArray(candidate.evidenceRefs),
      gaps: readStringArray(preflight.gaps ?? record.gaps).length > 0
        ? readStringArray(preflight.gaps ?? record.gaps)
        : gaps,
    }];
  });
}

function Section({
  title,
  icon: Icon,
  children,
  id,
}: {
  title: string;
  icon: typeof CircleDot;
  children: ReactNode;
  id?: string;
}) {
  return (
    <section id={id} className="min-w-0 space-y-3 border-t border-border pt-4">
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
        {title}
      </h2>
      {children}
    </section>
  );
}

function EvidenceList({ refs }: { refs: string[] }) {
  if (refs.length === 0) return null;
  const itemLabel = refs.length === 1 ? "item" : "items";
  return (
    <div aria-label="Supporting evidence" className="border-l border-border pl-2 text-xs text-muted-foreground">
      Based on {refs.length} supporting {itemLabel}
    </div>
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
  if (facet === "ready_for_acceptance") return "Ready for acceptance";
  if (facet === "needs_attention" || facet === "needs_your_attention") return "Needs your attention";
  if (facet === "waiting_external" || facet === "waiting_for_external_result") return "Waiting for external result";
  return "Agent advancing";
}

export function GoalDetail() {
  const { goalId } = useParams<{ goalId: string }>();
  const location = useLocation();
  const debugMode = new URLSearchParams(location.search).get("goalDebug") === "1";
  const { selectedOrganizationId, setSelectedOrganizationId } = useOrganization();
  const { confirm, openNewGoal, promptText } = useDialog();
  const { closePanel } = usePanel();
  const { pushToast } = useToast();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const feedbackRef = useRef<HTMLTextAreaElement>(null);
  const feedbackRequestRef = useRef<{ identity: string; key: string } | null>(null);
  const resultRequestKeysRef = useRef(new Map<string, string>());
  const proposalRefs = useRef(new Map<string, HTMLElement>());
  const [feedbackBody, setFeedbackBody] = useState("");
  const [pendingFeedback, setPendingFeedback] = useState<PendingFeedback | null>(null);
  const [changeNotes, setChangeNotes] = useState<Record<string, string>>({});
  const [resultFeedback, setResultFeedback] = useState<Record<string, string>>({});

  const workspaceQuery = useQuery({
    queryKey: ["goals", "detail", goalId, "workspace"],
    queryFn: () => goalsApi.getWorkspace(goalId!),
    enabled: Boolean(goalId),
  });
  const workspace = workspaceQuery.data;
  const goal = workspace?.goal;
  const orgId = goal?.orgId ?? selectedOrganizationId;

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
    if (goal?.orgId && goal.orgId !== selectedOrganizationId) {
      setSelectedOrganizationId(goal.orgId, { source: "route_sync" });
    }
  }, [goal?.orgId, selectedOrganizationId, setSelectedOrganizationId]);
  useEffect(() => {
    setBreadcrumbs([{ label: "Goals", href: "/goals" }, { label: goal?.title ?? goalId ?? "Goal" }]);
  }, [goal?.title, goalId, setBreadcrumbs]);

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["goals", "detail", goalId, "workspace"] }),
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
    onSuccess: async () => {
      await invalidate();
      pushToast({ id: "goal-detail-operation", title: "Focus updated", tone: "success" });
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
      feedbackKind: feedback.feedbackKind,
      idempotencyKey: feedback.idempotencyKey,
    }),
    onMutate: (feedback) => setPendingFeedback({ ...feedback, status: "sending", error: null }),
    onSuccess: async () => {
      await invalidate();
      setPendingFeedback(null);
      feedbackRequestRef.current = null;
      requestAnimationFrame(() => feedbackRef.current?.focus());
    },
    onError: (error: Error, feedback) => {
      setPendingFeedback({ ...feedback, status: "failed", error: error.message });
      requestAnimationFrame(() => feedbackRef.current?.focus());
    },
  });

  const changeDecision = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: "approve" | "reject" }) => goalsApi.decideChangeProposal(id, {
      decision,
      note: changeNotes[id]?.trim() || undefined,
    }),
    onSuccess: async (_, variables) => {
      await invalidate();
      requestAnimationFrame(() => proposalRefs.current.get(`change:${variables.id}`)?.focus());
    },
  });

  const resultDecision = useMutation<unknown, Error, ResultDecisionInput>({
    mutationFn: ({ id, decision, feedback, idempotencyKey }) => decision === "accept"
      ? goalsApi.acceptResultProposal(id, { idempotencyKey })
      : goalsApi.rejectResultProposal(id, { idempotencyKey, feedback }),
    onSuccess: async (_, variables) => {
      await invalidate();
      if (variables.decision === "reject") {
        setResultFeedback((current) => ({ ...current, [variables.id]: "" }));
      }
      requestAnimationFrame(() => proposalRefs.current.get(`result:${variables.id}`)?.focus());
    },
  });

  const linkedProjects = useMemo(
    () => (projectsQuery.data ?? []).filter((project) => project.goalIds.includes(goalId!) || project.goalId === goalId),
    [goalId, projectsQuery.data],
  );
  const linkedIssues = useMemo(
    () => (issuesQuery.data ?? []).filter((issue) => issue.goalId === goalId),
    [goalId, issuesQuery.data],
  );
  const timeline = useMemo(() => normalizeTimeline(workspace?.timeline), [workspace?.timeline]);
  const changeProposals = useMemo(() => normalizeChangeProposals(workspace?.changeProposals), [workspace?.changeProposals]);
  const resultProposals = useMemo(() => normalizeResultProposals(workspace?.resultProposals), [workspace?.resultProposals]);

  if (workspaceQuery.isLoading) return <PageSkeleton variant="detail" />;
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
  const owner = agentsQuery.data?.find((agent) => agent.id === goal.ownerAgentId) ?? null;
  const currentGoalRecord = asRecord(workspace.currentGoal);
  const currentGoalSummary = readString(currentGoalRecord, "summary")
    ?? goal.outcomeStatement
    ?? goal.description
    ?? goal.title;
  const agentActionRecord = asRecord(workspace.agentAction);
  const agentAction = readString(agentActionRecord, "summary")
    ?? (isDraft ? "Work has not started while this Goal is being aligned." : "No active bounded action is available.");
  const nextStepRecord = asRecord(workspace.nextStep);
  const nextStep = readString(nextStepRecord, "summary")
    ?? goal.continuationSummary
    ?? (isDraft ? workspace.attention?.reason : null)
    ?? "No next step has been recorded.";
  const wakeCondition = readString(nextStepRecord, "wakeCondition") ?? goal.wakeCondition ?? null;
  const readyProposals = resultProposals.filter((proposal) => proposal.status === "ready");
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
    targetTime: goal.evaluationDeadline ? String(goal.evaluationDeadline).slice(0, 16) : "",
  });
  const submitFeedback = () => {
    const body = feedbackBody.trim();
    if (!body || feedbackMutation.isPending) return;
    const feedbackKind = "ordinary" as const;
    const identity = `${feedbackKind}\0${body}`;
    if (feedbackRequestRef.current?.identity !== identity) {
      feedbackRequestRef.current = { identity, key: crypto.randomUUID() };
    }
    const pending: PendingFeedback = {
      identity,
      idempotencyKey: feedbackRequestRef.current.key,
      body,
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

  return (
    <div className="min-w-0 space-y-5 overflow-x-hidden pb-8">
      <header className="min-w-0 space-y-3">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <StatusBadge status={lifecycle} />
            <span className="text-xs text-muted-foreground">{facetLabel(workspace.facet)}</span>
            {goal.focus ? <span className="text-xs font-medium text-[color:var(--accent-base)]">Focus Goal</span> : null}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={rename}><Pencil className="mr-1.5 h-3.5 w-3.5" />Rename</Button>
            {isDraft ? <Button size="sm" onClick={continueAlignment}><Target className="mr-1.5 h-3.5 w-3.5" />Continue alignment</Button> : null}
            {isDraft ? <Button size="sm" variant="outline" onClick={remove} disabled={deleteGoal.isPending}><Trash2 className="mr-1.5 h-3.5 w-3.5" />Delete</Button> : null}
            {isActive ? <Button size="sm" variant={goal.focus ? "outline" : "default"} onClick={() => setFocus.mutate(!goal.focus)} disabled={setFocus.isPending}><Focus className="mr-1.5 h-3.5 w-3.5" />{goal.focus ? "Unfocus" : "Set focus"}</Button> : null}
          </div>
        </div>
        <InlineEditor value={goal.title} onSave={(title) => updateGoal.mutate({ title })} as="h1" className="min-w-0 whitespace-normal break-words text-2xl font-semibold" />
        <InlineEditor value={goal.description ?? ""} onSave={(description) => updateGoal.mutate({ description: markdownDocumentOrNull(description) })} as="p" className="min-w-0 whitespace-pre-wrap break-words text-sm text-muted-foreground" placeholder="Add context..." multiline editorEngine="codemirror" documentIdentity={`goal:${goal.id}`} />
      </header>

      <Section title="Current Goal" icon={Target}>
        <p className="min-w-0 whitespace-pre-wrap break-words text-sm leading-6">{currentGoalSummary}</p>
        {currentGoalRecord.updatedFromEvidence === true ? <p className="text-xs text-muted-foreground">Updated from evidence and feedback</p> : null}
      </Section>

      <Section title="Current progress" icon={Sparkles}>
        <p className="min-w-0 whitespace-pre-wrap break-words text-sm leading-6">{workspace.currentProgress.summary}</p>
        {workspace.currentProgress.uncertainty ? <p className="min-w-0 whitespace-pre-wrap break-words text-xs text-muted-foreground">{workspace.currentProgress.uncertainty}</p> : null}
        <EvidenceList refs={workspace.currentProgress.evidenceRefs ?? []} />
      </Section>

      {hasAttention ? (
        <Section title="Needs your attention" icon={ShieldCheck}>
          {workspace.attention ? (
            <div className="min-w-0 border-l-2 border-amber-500/50 pl-3">
              <div className="text-xs font-medium text-muted-foreground">{workspace.attention.kind}</div>
              <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6">{workspace.attention.reason}</p>
              {workspace.attention.impact ? <p className="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground">{workspace.attention.impact}</p> : null}
              <EvidenceList refs={workspace.attention.evidenceRefs ?? []} />
              {isDraft ? <Button type="button" size="sm" className="mt-3" onClick={continueAlignment}>Continue alignment</Button> : null}
            </div>
          ) : null}

          {pendingChanges.map((proposal) => {
            const isPending = changeDecision.isPending && changeDecision.variables?.id === proposal.id;
            const error = changeDecision.error && changeDecision.variables?.id === proposal.id ? changeDecision.error : null;
            return (
              <article
                key={proposal.id}
                ref={(element) => {
                  if (element) proposalRefs.current.set(`change:${proposal.id}`, element);
                  else proposalRefs.current.delete(`change:${proposal.id}`);
                }}
                tabIndex={-1}
                aria-label="Goal change proposal"
                className="min-w-0 rounded-md border border-amber-500/35 bg-amber-500/5 p-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <div className="text-sm font-semibold">Proposed Goal change</div>
                <div className="mt-3 grid min-w-0 gap-3 sm:grid-cols-2">
                  <div className="min-w-0"><div className="text-xs font-medium text-muted-foreground">Before</div><p className="mt-1 whitespace-pre-wrap break-words text-sm">{proposal.before}</p></div>
                  <div className="min-w-0"><div className="text-xs font-medium text-muted-foreground">After</div><p className="mt-1 whitespace-pre-wrap break-words text-sm">{proposal.after}</p></div>
                </div>
                {proposal.rationale ? <p className="mt-3 whitespace-pre-wrap break-words text-sm">{proposal.rationale}</p> : null}
                {proposal.impact ? <p className="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground">Impact: {proposal.impact}</p> : null}
                <EvidenceList refs={proposal.evidenceRefs} />
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
                  <Button type="button" size="sm" variant="outline" disabled={isPending} onClick={() => changeDecision.mutate({ id: proposal.id, decision: "reject" })}>Reject</Button>
                  <Button type="button" size="sm" disabled={isPending} onClick={() => changeDecision.mutate({ id: proposal.id, decision: "approve" })}><Check className="mr-1.5 h-3.5 w-3.5" />Approve</Button>
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
                ref={(element) => {
                  if (element) proposalRefs.current.set(`result:${proposal.id}`, element);
                  else proposalRefs.current.delete(`result:${proposal.id}`);
                }}
                tabIndex={-1}
                aria-label="Goal result proposal"
                className="min-w-0 rounded-md border border-emerald-500/35 bg-emerald-500/5 p-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <div className="text-sm font-semibold">Result proposed</div>
                <p className="mt-2 min-w-0 whitespace-pre-wrap break-words text-sm leading-6">{proposal.outcome}</p>
                {proposal.risks ? <p className="mt-2 min-w-0 whitespace-pre-wrap break-words text-xs text-muted-foreground">Risks: {proposal.risks}</p> : null}
                {proposal.gaps.length > 0 ? <p className="mt-2 min-w-0 whitespace-pre-wrap break-words text-xs text-muted-foreground">Gaps: {proposal.gaps.join("; ")}</p> : null}
                <EvidenceList refs={proposal.evidenceRefs} />
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
                      id: proposal.id,
                      decision: "reject",
                      feedback: rejection.trim(),
                      idempotencyKey: resultKey(proposal.id, "reject", rejection),
                    })}
                  >
                    Result is not sufficient
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={isPending}
                    onClick={() => resultDecision.mutate({
                      id: proposal.id,
                      decision: "accept",
                      idempotencyKey: resultKey(proposal.id, "accept"),
                    })}
                  >
                    <FileCheck2 className="mr-1.5 h-3.5 w-3.5" />Accept result
                  </Button>
                </div>
              </article>
            );
          })}
        </Section>
      ) : null}

      {lifecycle === "closed" ? (
        <Section title="Result accepted" icon={FileCheck2}>
          <p className="text-sm font-medium">{evaluationOutcome ?? goal.status}</p>
        </Section>
      ) : null}

      <Section title="Agent is doing" icon={UserRound}>
        <p className="min-w-0 whitespace-pre-wrap break-words text-sm leading-6">{agentAction}</p>
        <p className="text-xs text-muted-foreground">Owner: {owner?.name ?? (goal.ownerAgentId ? `Agent ${goal.ownerAgentId.slice(0, 8)}` : "Unassigned")}</p>
      </Section>

      <Section title="Next step" icon={ArrowRight}>
        <p className="min-w-0 whitespace-pre-wrap break-words text-sm leading-6">{nextStep}</p>
        {wakeCondition ? <p className="min-w-0 whitespace-pre-wrap break-words text-xs text-muted-foreground">Resume when: {wakeCondition}</p> : null}
      </Section>

      <Section title="Progress and feedback" icon={History}>
        <div className="divide-y divide-border border-y border-border">
          {timeline.length === 0 && !pendingFeedback ? <p className="py-3 text-sm text-muted-foreground">No progress or feedback yet.</p> : null}
          {timeline.map((entry) => (
            <div key={entry.id} className="min-w-0 space-y-1 py-2.5">
              <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                <div className="text-xs font-medium text-muted-foreground">{entry.actorName ?? entry.kind}</div>
                {entry.createdAt ? <div className="shrink-0 text-xs text-muted-foreground">{formatDate(entry.createdAt)}</div> : null}
              </div>
              <p className="min-w-0 whitespace-pre-wrap break-words text-sm leading-6">{entry.summary}</p>
              <EvidenceList refs={entry.evidenceRefs} />
            </div>
          ))}
          {pendingFeedback ? (
            <div className={cn("min-w-0 space-y-1 py-2.5", pendingFeedback.status === "failed" && "text-destructive")}>
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                <div className="text-xs font-medium">You</div>
                <div className="text-xs">{pendingFeedback.status === "sending" ? "Sending..." : "Not sent"}</div>
              </div>
              <p className="min-w-0 whitespace-pre-wrap break-words text-sm leading-6">{pendingFeedback.body}</p>
              {pendingFeedback.error ? <p role="alert" className="text-xs">{pendingFeedback.error}</p> : null}
              {pendingFeedback.status === "failed" ? (
                <Button type="button" size="sm" variant="outline" onClick={() => feedbackMutation.mutate(pendingFeedback)}>Retry feedback</Button>
              ) : null}
            </div>
          ) : null}
        </div>

        {!isDraft ? <div className="min-w-0 space-y-2">
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
          <div className="flex justify-end">
            <Button type="button" size="sm" onClick={submitFeedback} disabled={!feedbackBody.trim() || feedbackMutation.isPending}>
              <MessageSquareText className="mr-1.5 h-3.5 w-3.5" />Send feedback
            </Button>
          </div>
        </div> : null}
      </Section>

      <Section title="Goal details and related work" icon={Clock3}>
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <div className="min-w-0"><div className="text-xs text-muted-foreground">Owner</div><div className="mt-1 min-w-0 break-words text-sm">{owner?.name ?? "Unassigned"}</div></div>
          <div className="min-w-0"><div className="text-xs text-muted-foreground">Target time</div><div className="mt-1 min-w-0 break-words text-sm">{goal.actionDeadline ? formatDate(goal.actionDeadline) : "Not set"}</div></div>
        </div>
        {goal.criteria && goal.criteria.length > 0 ? (
          <div className="divide-y divide-border border-y border-border">
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
