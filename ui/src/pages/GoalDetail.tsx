import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Link, useNavigate, useParams } from "@/lib/router";
import { GOAL_CONTINUATION_KINDS, GOAL_EVALUATOR_KINDS, GOAL_OBJECTIVE_MODES, type GoalActivity, type GoalDependencies, type GoalEvaluatorKind, type GoalObjectiveMode, type Issue, type Project } from "@rudderhq/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CircleDot, ClipboardCheck, Focus, Pencil, Play, Plus, ShieldCheck, Trash2, UserRound } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
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
import { formatDate, issueUrl, projectUrl } from "../lib/utils";

const fieldClassName = "mt-1 w-full rounded border border-border bg-background px-2.5 py-2 text-sm outline-none focus:border-ring";

type DraftCriterion = {
  id: string;
  label: string;
  evaluator: GoalEvaluatorKind;
  evidenceRequirements: string;
};

function newDraftCriterion(index = 0): DraftCriterion {
  return {
    id: `criterion-${index + 1}`,
    label: index === 0 ? "The desired external outcome is true" : "The supporting condition remains safe",
    evaluator: index === 0 ? "artifact" : "policy",
    evidenceRequirements: "",
  };
}

function Section({ title, icon: Icon, children }: { title: string; icon: typeof CircleDot; children: ReactNode }) {
  return (
    <section className="space-y-3 border-t border-border pt-5">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <Icon className="h-4 w-4 text-muted-foreground" />
        {title}
      </div>
      {children}
    </section>
  );
}

function ActivityFeed({ activities }: { activities: GoalActivity[] }) {
  if (activities.length === 0) return <p className="text-sm text-muted-foreground">No Goal activity yet.</p>;
  return (
    <div className="divide-y divide-border border border-border">
      {activities.map((activity) => (
        <div key={activity.id} className="space-y-1 px-3 py-2.5">
          <div className="flex items-start justify-between gap-3">
            <span className="text-sm">{activity.summary}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{formatDate(activity.occurredAt)}</span>
          </div>
          <div className="flex flex-wrap gap-3 text-[11px] text-muted-foreground">
            <span>{activity.activityKind ?? "progress"}</span>
            {activity.runRef && <span>Run {activity.runRef.slice(0, 8)}</span>}
            {activity.evidenceRefs.length > 0 && <span>{activity.evidenceRefs.length} evidence reference(s)</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

function WorkLinks({ projects, issues }: { projects: Project[]; issues: Issue[] }) {
  if (projects.length === 0 && issues.length === 0) return <p className="text-sm text-muted-foreground">No linked work.</p>;
  return (
    <div className="divide-y divide-border border border-border">
      {projects.map((project) => <Link key={`project-${project.id}`} to={projectUrl(project)} className="flex items-center justify-between px-3 py-2 text-sm hover:bg-accent/40"><span>{project.name}</span><span className="text-xs text-muted-foreground">Project</span></Link>)}
      {issues.map((issue) => <Link key={`issue-${issue.id}`} to={issueUrl(issue)} className="flex items-center justify-between px-3 py-2 text-sm hover:bg-accent/40"><span>{issue.identifier ?? issue.title}</span><span className="truncate pl-3 text-xs text-muted-foreground">{issue.title}</span></Link>)}
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
const dependencyPreviewKeys: Record<string, keyof GoalDependencies["previews"]> = {
  child_goals: "childGoals",
  linked_projects: "linkedProjects",
  linked_issues: "linkedIssues",
  automations: "automations",
  calendar_events: "calendarEvents",
};

function DeletionBlockers({ dependencies }: { dependencies: GoalDependencies }) {
  const previewGroups = Object.entries(dependencies.previews).filter(([, previews]) => previews.length > 0);
  if (dependencies.canDelete || (previewGroups.length === 0 && dependencies.blockers.length === 0)) return null;
  return (
    <Section title="Deletion blockers" icon={ShieldCheck}>
      <p className="text-sm text-muted-foreground">This draft still has linked records and cannot be deleted.</p>
      <div className="divide-y divide-border border border-border">
        {previewGroups.map(([kind, previews]) => (
          <div key={kind} className="px-3 py-2.5">
            <div className="text-xs font-medium text-foreground">{dependencyLabels[kind] ?? kind}</div>
            <div className="mt-1 divide-y divide-border border border-border">
              {previews.map((preview) => (
                <div key={preview.id} className="flex items-start justify-between gap-3 px-2.5 py-2 text-sm">
                  <span className="min-w-0 break-words">{preview.title}</span>
                  {preview.subtitle && <span className="shrink-0 text-xs text-muted-foreground">{preview.subtitle}</span>}
                </div>
              ))}
            </div>
          </div>
        ))}
        {dependencies.blockers.filter((blocker) => !dependencyPreviewKeys[blocker]).map((blocker) => (
          <div key={blocker} className="px-3 py-2 text-sm text-muted-foreground">{dependencyLabels[blocker] ?? blocker}</div>
        ))}
      </div>
    </Section>
  );
}

export function GoalDetail() {
  const { goalId } = useParams<{ goalId: string }>();
  const { selectedOrganizationId, setSelectedOrganizationId } = useOrganization();
  const { confirm, promptText } = useDialog();
  const { closePanel } = usePanel();
  const { pushToast } = useToast();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [objectiveMode, setObjectiveMode] = useState<GoalObjectiveMode>("target");
  const [outcomeStatement, setOutcomeStatement] = useState("");
  const [criteria, setCriteria] = useState<DraftCriterion[]>([newDraftCriterion()]);
  const [autonomyAllowed, setAutonomyAllowed] = useState("bounded_work");
  const [humanAcceptanceAuthority, setHumanAcceptanceAuthority] = useState("operator");
  const [terminalEvidenceRequired, setTerminalEvidenceRequired] = useState(true);
  const [actionDeadline, setActionDeadline] = useState("");
  const [evaluationDeadline, setEvaluationDeadline] = useState("");
  const [ownerAgentId, setOwnerAgentId] = useState("");
  const [continuationKind, setContinuationKind] = useState<(typeof GOAL_CONTINUATION_KINDS)[number]>("commitment");
  const [continuationSummary, setContinuationSummary] = useState("Start the first bounded commitment");
  const [planSummary, setPlanSummary] = useState("Test the first strategy and report what changed");
  const [activitySummary, setActivitySummary] = useState("");
  const [evidence, setEvidence] = useState("");
  const [criterionStatuses, setCriterionStatuses] = useState<Record<string, "met" | "unmet" | "breached" | "unknown">>({});
  const [resultValue, setResultValue] = useState("");
  const [decision, setDecision] = useState("");

  const { data: goal, isLoading, error } = useQuery({
    queryKey: queryKeys.goals.detail(goalId!),
    queryFn: () => goalsApi.get(goalId!),
    enabled: !!goalId,
  });
  const orgId = goal?.orgId ?? selectedOrganizationId;
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(orgId!),
    queryFn: () => agentsApi.list(orgId!),
    enabled: !!orgId,
  });
  const { data: allProjects } = useQuery({
    queryKey: queryKeys.projects.list(orgId!),
    queryFn: () => projectsApi.list(orgId!),
    enabled: !!orgId,
  });
  const { data: allIssues } = useQuery({
    queryKey: queryKeys.issues.list(orgId!),
    queryFn: () => issuesApi.list(orgId!),
    enabled: !!orgId,
  });
  const { data: dependencies } = useQuery({
    queryKey: queryKeys.goals.dependencies(goalId!),
    queryFn: () => goalsApi.dependencies(goalId!),
    enabled: !!goalId && !!goal,
  });

  useEffect(() => closePanel(), [closePanel]);
  useEffect(() => {
    if (goal?.orgId && goal.orgId !== selectedOrganizationId) setSelectedOrganizationId(goal.orgId, { source: "route_sync" });
  }, [goal?.orgId, selectedOrganizationId, setSelectedOrganizationId]);
  useEffect(() => {
    setBreadcrumbs([{ label: "Goals", href: "/goals" }, { label: goal?.title ?? goalId ?? "Goal" }]);
  }, [goal?.title, goalId, setBreadcrumbs]);
  useEffect(() => {
    if (!goal) return;
    setObjectiveMode(goal.objectiveMode ?? "target");
    setOutcomeStatement(goal.outcomeStatement ?? "");
    setOwnerAgentId(goal.ownerAgentId ?? "");
    setPlanSummary(goal.plan?.summary ?? "Test the first strategy and report what changed");
    setCriteria([newDraftCriterion()]);
    setAutonomyAllowed("bounded_work");
    setHumanAcceptanceAuthority("operator");
    setTerminalEvidenceRequired(true);
    setActionDeadline("");
    setEvaluationDeadline("");
  }, [goal?.id, goal?.objectiveMode, goal?.outcomeStatement, goal?.ownerAgentId, goal?.plan?.summary]);
  useEffect(() => {
    if (!goal) return;
    setContinuationKind("commitment");
    setContinuationSummary("Start the first bounded commitment");
    setActivitySummary("");
    setEvidence("");
    setCriterionStatuses(Object.fromEntries((goal.criteria ?? []).map((criterion) => [criterion.id, "unknown" as const])));
    setResultValue("");
    setDecision("");
  }, [goal?.id, goal?.criteria]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.goals.detail(goalId!) });
    if (orgId) queryClient.invalidateQueries({ queryKey: queryKeys.goals.list(orgId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.goals.dependencies(goalId!) });
  };
  const mutationOptions = (title: string) => ({
    onSuccess: () => { invalidate(); pushToast({ id: "goal-detail-operation", title, tone: "success" }); },
    onError: (mutationError: Error) => pushToast({ title: mutationError.message, tone: "error" }),
  });
  const updateGoal = useMutation({ mutationFn: (data: Record<string, unknown>) => goalsApi.update(goalId!, data), ...mutationOptions("Goal updated") });
  const activateGoal = useMutation({
    mutationFn: () => goalsApi.activate(goalId!, {
      confirmed: true,
      ownerAgentId,
      outcomeStatement: outcomeStatement.trim(),
      objectiveMode,
      criteria: criteria.map((criterion) => ({
        id: criterion.id,
        label: criterion.label.trim(),
        evaluator: criterion.evaluator,
        ...(criterion.evidenceRequirements.trim()
          ? { evidenceRequirements: criterion.evidenceRequirements.split(",").map((value) => value.trim()).filter(Boolean) }
          : {}),
      })),
      autonomyEnvelope: { allowed: autonomyAllowed.split(",").map((value) => value.trim()).filter(Boolean) },
      humanAuthorities: { acceptance: humanAcceptanceAuthority.trim() },
      evaluationPolicy: { terminalEvidenceRequired },
      actionDeadline: actionDeadline || null,
      evaluationDeadline: evaluationDeadline || null,
      initialContinuation: { kind: continuationKind, summary: continuationSummary.trim() },
      initialPlan: { summary: planSummary.trim() },
    }),
    ...mutationOptions("Goal activated"),
  });
  const updatePlan = useMutation({ mutationFn: () => goalsApi.updatePlan(goalId!, { summary: planSummary.trim() }), ...mutationOptions("Plan revision recorded") });
  const addActivity = useMutation({ mutationFn: () => goalsApi.createActivity(goalId!, { summary: activitySummary.trim(), activityKind: "progress", idempotencyKey: `ui-${Date.now()}` }), ...mutationOptions("Activity recorded"), onSuccess: () => { setActivitySummary(""); invalidate(); pushToast({ id: "goal-detail-operation", title: "Activity recorded", tone: "success" }); } });
  const assignOwner = useMutation({ mutationFn: () => goalsApi.assignOwner(goalId!, { agentId: ownerAgentId, authorityRef: "operator" }), ...mutationOptions("Owner reassigned") });
  const setFocus = useMutation({ mutationFn: (focus: boolean) => goalsApi.setFocus(goalId!, focus), ...mutationOptions("Focus updated") });
  const evaluate = useMutation({
    mutationFn: () => goalsApi.evaluate(goalId!, {
      evidenceRefs: evidence.split(",").map((value) => value.trim()).filter(Boolean),
      criteria: (goal?.criteria ?? []).map((criterion) => ({ id: criterion.id, status: criterionStatuses[criterion.id] ?? "unknown" })),
      ...((goal?.criteria ?? []).some((criterion) => criterion.evaluator === "metric") && resultValue.trim() ? { resultValue: resultValue.trim() } : {}),
      ...((goal?.criteria ?? []).some((criterion) => criterion.evaluator === "human") && decision.trim() ? { decision: decision.trim() } : {}),
      resultPayload: {},
    }),
    ...mutationOptions("Goal evaluated"),
  });
  const deleteGoal = useMutation({
    mutationFn: () => goalsApi.remove(goalId!),
    onSuccess: () => { if (orgId) queryClient.invalidateQueries({ queryKey: queryKeys.goals.list(orgId) }); navigate("/goals"); },
    onError: (mutationError: Error) => pushToast({ title: mutationError.message, tone: "error" }),
  });

  const linkedProjects = useMemo(() => (allProjects ?? []).filter((project) => project.goalIds.includes(goalId!) || project.goalId === goalId), [allProjects, goalId]);
  const linkedIssues = useMemo(() => (allIssues ?? []).filter((issue) => issue.goalId === goalId), [allIssues, goalId]);
  const lifecycle = goal?.lifecycle ?? "draft";
  const isDraft = lifecycle === "draft";
  const isActive = lifecycle === "active";
  const isClosed = lifecycle === "closed";

  if (isLoading) return <PageSkeleton variant="detail" />;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;
  if (!goal) return null;

  const rename = async () => {
    const title = await promptText({ title: "Rename Goal", label: "Title", defaultValue: goal.title, confirmLabel: "Save" });
    if (title?.trim() && title.trim() !== goal.title) updateGoal.mutate({ title: title.trim() });
  };
  const remove = async () => {
    if (dependencies && !dependencies.canDelete) {
      pushToast({ title: "Goal cannot be deleted", body: dependencies.blockers.join(", "), tone: "warn" });
      return;
    }
    if (await confirm({ title: "Delete draft Goal?", description: "This removes the unlinked draft record.", confirmLabel: "Delete", tone: "destructive" })) deleteGoal.mutate();
  };

  return (
    <div className="space-y-6 pb-8">
      <header className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <StatusBadge status={lifecycle} />
            {goal.focus && <span className="text-xs font-medium text-[color:var(--accent-base)]">Focus Goal</span>}
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={rename}><Pencil className="mr-1.5 h-3.5 w-3.5" />Rename</Button>
            {isDraft && <Button size="sm" variant="outline" onClick={remove} disabled={deleteGoal.isPending}><Trash2 className="mr-1.5 h-3.5 w-3.5" />Delete</Button>}
            {isActive && <Button size="sm" variant={goal.focus ? "outline" : "default"} onClick={() => setFocus.mutate(!goal.focus)} disabled={setFocus.isPending}><Focus className="mr-1.5 h-3.5 w-3.5" />{goal.focus ? "Unfocus" : "Set focus"}</Button>}
          </div>
        </div>
        <InlineEditor value={goal.title} onSave={(title) => updateGoal.mutate({ title })} as="h1" className="text-2xl font-semibold" />
        <InlineEditor value={goal.description ?? ""} onSave={(description) => updateGoal.mutate({ description: markdownDocumentOrNull(description) })} as="p" className="text-sm text-muted-foreground" placeholder="Add context..." multiline editorEngine="codemirror" documentIdentity={`goal:${goal.id}`} />
      </header>

      {isDraft && dependencies && !dependencies.canDelete && <DeletionBlockers dependencies={dependencies} />}

      {isDraft && (
        <Section title="Contract activation" icon={Play}>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-muted-foreground">Objective mode<select className={fieldClassName} value={objectiveMode} onChange={(event) => setObjectiveMode(event.target.value as GoalObjectiveMode)}>{GOAL_OBJECTIVE_MODES.map((mode) => <option key={mode} value={mode}>{mode}</option>)}</select></label>
            <label className="text-xs text-muted-foreground">Agent Owner<select aria-label="Agent Owner" className={fieldClassName} value={ownerAgentId} onChange={(event) => setOwnerAgentId(event.target.value)}><option value="">Select an Agent</option>{(agents ?? []).map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
          </div>
          <label className="block text-xs text-muted-foreground">Outcome statement<input className={fieldClassName} value={outcomeStatement} onChange={(event) => setOutcomeStatement(event.target.value)} placeholder="What external result should become true?" /></label>
          <div className="space-y-3">
            {criteria.map((criterion, index) => (
              <div key={criterion.id} className="border border-border p-3">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <span className="text-xs font-medium text-foreground">Criterion {index + 1}</span>
                  {criteria.length > 1 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Remove criterion ${index + 1}`}
                      onClick={() => setCriteria((current) => current.filter((item) => item.id !== criterion.id))}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="text-xs text-muted-foreground">Criterion<input aria-label={`Criterion ${index + 1}`} className={fieldClassName} value={criterion.label} onChange={(event) => setCriteria((current) => current.map((item) => item.id === criterion.id ? { ...item, label: event.target.value } : item))} /></label>
                  <label className="text-xs text-muted-foreground">Evaluator<select aria-label={`Evaluator for criterion ${index + 1}`} className={fieldClassName} value={criterion.evaluator} onChange={(event) => setCriteria((current) => current.map((item) => item.id === criterion.id ? { ...item, evaluator: event.target.value as GoalEvaluatorKind } : item))}>{GOAL_EVALUATOR_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}</select></label>
                </div>
                <label className="mt-3 block text-xs text-muted-foreground">Evidence requirements<input aria-label={`Evidence requirements for criterion ${index + 1}`} className={fieldClassName} value={criterion.evidenceRequirements} onChange={(event) => setCriteria((current) => current.map((item) => item.id === criterion.id ? { ...item, evidenceRequirements: event.target.value } : item))} placeholder="artifact://required, run://required" /></label>
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" onClick={() => setCriteria((current) => {
              const criterion = newDraftCriterion(current.length);
              criterion.id = `criterion-${Date.now()}`;
              return [...current, criterion];
            })}>
              <Plus className="mr-1.5 h-3.5 w-3.5" />Add criterion
            </Button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-muted-foreground">Allowed autonomy<input aria-label="Allowed autonomy" className={fieldClassName} value={autonomyAllowed} onChange={(event) => setAutonomyAllowed(event.target.value)} placeholder="bounded_work" /></label>
            <label className="text-xs text-muted-foreground">Human acceptance authority<input aria-label="Human acceptance authority" className={fieldClassName} value={humanAcceptanceAuthority} onChange={(event) => setHumanAcceptanceAuthority(event.target.value)} placeholder="operator" /></label>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-muted-foreground">Action deadline<input aria-label="Action deadline" type="date" className={fieldClassName} value={actionDeadline} onChange={(event) => setActionDeadline(event.target.value)} /></label>
            <label className="text-xs text-muted-foreground">Evaluation deadline<input aria-label="Evaluation deadline" type="date" min={actionDeadline || undefined} className={fieldClassName} value={evaluationDeadline} onChange={(event) => setEvaluationDeadline(event.target.value)} /></label>
          </div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input aria-label="Terminal evidence required" type="checkbox" checked={terminalEvidenceRequired} onChange={(event) => setTerminalEvidenceRequired(event.target.checked)} />
            Require terminal evidence before Proof
          </label>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="text-xs text-muted-foreground">Continuation<select className={fieldClassName} value={continuationKind} onChange={(event) => setContinuationKind(event.target.value as typeof continuationKind)}>{GOAL_CONTINUATION_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}</select></label>
            <label className="text-xs text-muted-foreground sm:col-span-2">First next step<input className={fieldClassName} value={continuationSummary} onChange={(event) => setContinuationSummary(event.target.value)} /></label>
          </div>
          <label className="block text-xs text-muted-foreground">Initial Plan<textarea className={`${fieldClassName} min-h-20 resize-y`} value={planSummary} onChange={(event) => setPlanSummary(event.target.value)} /></label>
          <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
            <span className="text-xs text-muted-foreground">Activation is recorded as an operator confirmation.</span>
            <Button onClick={() => activateGoal.mutate()} disabled={activateGoal.isPending || !ownerAgentId || !outcomeStatement.trim() || criteria.some((criterion) => !criterion.label.trim()) || !autonomyAllowed.trim() || !humanAcceptanceAuthority.trim() || !continuationSummary.trim() || !planSummary.trim()}><Play className="mr-1.5 h-3.5 w-3.5" />{activateGoal.isPending ? "Activating..." : "Confirm activation"}</Button>
          </div>
        </Section>
      )}

      <Section title="Contract" icon={ShieldCheck}>
        <div className="grid gap-3 sm:grid-cols-3">
          <div><div className="text-[11px] uppercase text-muted-foreground">Mode</div><div className="mt-1 text-sm">{goal.objectiveMode ?? "target"}</div></div>
          <div><div className="text-[11px] uppercase text-muted-foreground">Contract revision</div><div className="mt-1 text-sm">{goal.contractRevision ?? 1}</div></div>
          <div><div className="text-[11px] uppercase text-muted-foreground">Owner</div><div className="mt-1 text-sm">{agents?.find((agent) => agent.id === goal.ownerAgentId)?.name ?? (goal.ownerAgentId ? goal.ownerAgentId.slice(0, 8) : "Unassigned")}</div></div>
        </div>
        <p className="text-sm text-foreground">{goal.outcomeStatement ?? "Draft contract has no outcome statement."}</p>
        {goal.criteria && goal.criteria.length > 0 && <div className="divide-y divide-border border border-border">{goal.criteria.map((criterion) => <div key={criterion.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm"><span>{criterion.label}</span><span className="text-xs text-muted-foreground">{criterion.evaluator}</span></div>)}</div>}
      </Section>

      <Section title="Plan" icon={CircleDot}>
        {goal.plan ? <div className="space-y-2"><div className="flex flex-wrap items-start justify-between gap-3"><p className="min-w-0 flex-1 text-sm">{goal.plan.summary}</p><span className="whitespace-nowrap text-xs text-muted-foreground">Revision {goal.plan.revision}</span></div>{isActive && <div className="flex gap-2"><Textarea aria-label="Plan revision" value={planSummary} onChange={(event) => setPlanSummary(event.target.value)} className="min-h-9 flex-1" /><Button variant="outline" size="sm" onClick={() => updatePlan.mutate()} disabled={!planSummary.trim() || updatePlan.isPending}>Save revision</Button></div>}</div> : <p className="text-sm text-muted-foreground">No Plan yet.</p>}
      </Section>

      {!isDraft && (
        <Section title="Owner and continuation" icon={UserRound}>
          <div className="grid gap-3 sm:grid-cols-2">
            <div><div className="text-[11px] uppercase text-muted-foreground">Current owner</div><div className="mt-1 text-sm">{agents?.find((agent) => agent.id === goal.ownerAgentId)?.name ?? (goal.ownerAgentId ? goal.ownerAgentId.slice(0, 8) : "Unassigned")}</div></div>
            <div><div className="text-[11px] uppercase text-muted-foreground">Continuation</div><div className="mt-1 text-sm">{goal.continuationKind ?? "Not set"}</div></div>
          </div>
          <p className="text-sm">{goal.continuationSummary ?? "No continuation has been recorded."}</p>
          {goal.wakeCondition && <p className="text-xs text-muted-foreground">Wake condition: {goal.wakeCondition}</p>}
          {isActive && <div className="flex flex-wrap items-end gap-2"><label className="min-w-60 flex-1 text-xs text-muted-foreground">Current or replacement Owner<select className={fieldClassName} value={ownerAgentId} onChange={(event) => setOwnerAgentId(event.target.value)}>{(agents ?? []).map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label><Button variant="outline" size="sm" onClick={() => assignOwner.mutate()} disabled={!ownerAgentId || assignOwner.isPending}>Reassign Owner</Button></div>}
        </Section>
      )}

      {isActive && (
        <Section title="Evaluate" icon={ClipboardCheck}>
          <label className="block text-xs text-muted-foreground">Evidence references<input className={fieldClassName} value={evidence} onChange={(event) => setEvidence(event.target.value)} placeholder="A stable URL, artifact, run, or decision reference" /></label>
          <div className="grid gap-3 sm:grid-cols-2">
            {(goal.criteria ?? []).map((criterion) => (
              <label key={criterion.id} className="text-xs text-muted-foreground">{criterion.label}
                <select aria-label={`Criterion result: ${criterion.label}`} className={fieldClassName} value={criterionStatuses[criterion.id] ?? "unknown"} onChange={(event) => setCriterionStatuses((current) => ({ ...current, [criterion.id]: event.target.value as "met" | "unmet" | "breached" | "unknown" }))}>
                  <option value="unknown">unknown</option>
                  <option value="met">met</option>
                  <option value="unmet">unmet</option>
                  <option value="breached">breached</option>
                </select>
              </label>
            ))}
            {goal.criteria?.some((criterion) => criterion.evaluator === "metric") && <label className="text-xs text-muted-foreground">Observed result<input aria-label="Observed result" className={fieldClassName} value={resultValue} onChange={(event) => setResultValue(event.target.value)} /></label>}
            {goal.criteria?.some((criterion) => criterion.evaluator === "human") && <label className="text-xs text-muted-foreground">Human decision<input aria-label="Human decision" className={fieldClassName} value={decision} onChange={(event) => setDecision(event.target.value)} /></label>}
          </div>
          <Button onClick={() => evaluate.mutate()} disabled={evaluate.isPending || !evidence.trim()}><Check className="mr-1.5 h-3.5 w-3.5" />Evaluate from evidence</Button>
        </Section>
      )}

      {isClosed && <Section title="Proof" icon={ClipboardCheck}><div className="border border-border px-3 py-3"><div className="text-sm font-medium">{String(goal.evaluationResult?.outcome ?? "inconclusive")}</div><div className="mt-1 text-xs text-muted-foreground">Evaluation is derived from the submitted evidence and cannot be edited as a status.</div></div></Section>}

      <Section title="Activity" icon={CircleDot}>
        {isActive && <div className="flex gap-2"><Textarea aria-label="Activity summary" value={activitySummary} onChange={(event) => setActivitySummary(event.target.value)} placeholder="Record a material Goal update..." className="min-h-9 flex-1" /><Button variant="outline" size="sm" onClick={() => addActivity.mutate()} disabled={!activitySummary.trim() || addActivity.isPending}><Plus className="mr-1.5 h-3.5 w-3.5" />Add activity</Button></div>}
        <ActivityFeed activities={goal.activities ?? []} />
      </Section>

      <Section title="Linked work" icon={CircleDot}><WorkLinks projects={linkedProjects} issues={linkedIssues} /></Section>
    </div>
  );
}
