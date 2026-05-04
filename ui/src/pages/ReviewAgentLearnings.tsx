import { useMemo } from "react";
import { Link, useNavigate, useParams } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CheckCircle2, CircleDot, GitPullRequest, Loader2, ShieldCheck, XCircle } from "lucide-react";
import type { LearningCandidate, SkillUpdateProposal } from "@rudderhq/shared";
import { agentLearningApi } from "../api/agentLearning";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "../components/StatusBadge";
import { useOrganization } from "../context/OrganizationContext";
import { useToast } from "../context/ToastContext";
import { useViewedOrganization } from "../hooks/useViewedOrganization";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";

function proposalStatusClassName(status: string) {
  switch (status) {
    case "applied":
    case "approved":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "rejected":
      return "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300";
    default:
      return "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300";
  }
}

function candidateStatusClassName(status: string) {
  switch (status) {
    case "approved":
    case "applied":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "rejected":
      return "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300";
    case "one_off":
      return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    default:
      return "border-border bg-muted/40 text-muted-foreground";
  }
}

function formatStatus(status: string) {
  return status.replaceAll("_", " ");
}

function formatRecord(value: Record<string, unknown> | null | undefined) {
  if (!value || Object.keys(value).length === 0) return "similar future work";
  return Object.entries(value)
    .map(([key, item]) => `${key}: ${typeof item === "string" ? item : JSON.stringify(item)}`)
    .join(", ");
}

function pickPrimaryProposal(proposals: SkillUpdateProposal[]) {
  return proposals.find((proposal) => proposal.status === "pending")
    ?? proposals.find((proposal) => proposal.status === "applied")
    ?? proposals[0]
    ?? null;
}

export function ReviewAgentLearnings() {
  const { agentId, batchId } = useParams<{ agentId?: string; batchId?: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { selectedOrganizationId } = useOrganization();
  const { viewedOrganizationId } = useViewedOrganization();
  const orgId = viewedOrganizationId ?? selectedOrganizationId;
  const { pushToast } = useToast();

  const reviewQuery = useQuery({
    queryKey: queryKeys.agentLearning.batchReview(orgId ?? "__none__", batchId ?? "__none__"),
    queryFn: () => agentLearningApi.batchReview(orgId!, batchId!),
    enabled: Boolean(orgId && batchId),
  });

  const invalidateReview = async () => {
    if (!orgId || !batchId) return;
    await queryClient.invalidateQueries({ queryKey: queryKeys.agentLearning.batchReview(orgId, batchId) });
  };

  const applyProposal = useMutation({
    mutationFn: (proposalId: string) => agentLearningApi.applyProposal(orgId!, proposalId),
    onSuccess: async (result) => {
      await Promise.all([
        invalidateReview(),
        queryClient.invalidateQueries({ queryKey: queryKeys.agentLearning.summary(orgId!, reviewQuery.data!.agent.id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.skills(reviewQuery.data!.agent.id) }),
      ]);
      pushToast({
        title: "AI skill proposal applied",
        body: result.skill
          ? `${result.skill.name} will load in future runs.`
          : "The approved skill update was applied.",
        tone: "success",
      });
      navigate(`/agents/${agentId ?? reviewQuery.data!.agent.urlKey}/learning`);
    },
    onError: (error) => pushToast({
      title: "Could not apply proposal",
      body: error instanceof Error ? error.message : "Apply failed.",
      tone: "error",
    }),
  });

  const rejectProposal = useMutation({
    mutationFn: (proposalId: string) => agentLearningApi.rejectProposal(orgId!, proposalId),
    onSuccess: async () => {
      await invalidateReview();
      pushToast({ title: "AI skill proposal rejected" });
    },
    onError: (error) => pushToast({
      title: "Could not reject proposal",
      body: error instanceof Error ? error.message : "Reject failed.",
      tone: "error",
    }),
  });

  const review = reviewQuery.data;
  const primaryProposal = useMemo(
    () => pickPrimaryProposal(review?.proposals ?? []),
    [review?.proposals],
  );

  if (!orgId || !batchId) {
    return <div className="mx-auto max-w-3xl py-10 text-sm text-muted-foreground">Missing learning review context.</div>;
  }

  if (reviewQuery.isLoading) {
    return <div className="mx-auto max-w-3xl py-10 text-sm text-muted-foreground">Loading skill update review...</div>;
  }

  if (reviewQuery.isError || !review) {
    return (
      <div className="mx-auto max-w-3xl py-10 text-sm text-destructive">
        {reviewQuery.error instanceof Error ? reviewQuery.error.message : "Could not load skill update review."}
      </div>
    );
  }

  const proposalBusy = applyProposal.isPending || rejectProposal.isPending;
  const proposalActionable = primaryProposal?.status === "pending";
  const targetSkillLabel = review.targetSkill?.name
    ?? primaryProposal?.targetSkillKey
    ?? "Learning";

  return (
    <div className="mx-auto w-full max-w-6xl space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link
            to={`/agents/${agentId ?? review.agent.urlKey}/learning`}
            className="mb-2 inline-flex items-center gap-1.5 text-xs text-muted-foreground no-underline hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to learning
          </Link>
          <h1 className="text-xl font-semibold tracking-tight">Review AI-generated skill update</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {review.feedbackItems.length} feedback item{review.feedbackItems.length === 1 ? "" : "s"} from run{" "}
            <span className="font-mono">{review.feedbackItems[0]?.runId.slice(0, 8) ?? review.batch.id.slice(0, 8)}</span>
            {" "}- Scope: {review.agent.name}
          </p>
        </div>
        <Button
          className="gap-2"
          onClick={() => primaryProposal && applyProposal.mutate(primaryProposal.id)}
          disabled={!primaryProposal || !proposalActionable || proposalBusy}
        >
          {applyProposal.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
          Apply AI proposal
        </Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[20rem_minmax(0,1fr)]">
        <aside className="space-y-3 rounded-xl border border-border bg-[color:var(--surface-elevated)] p-3">
          <div>
            <div className="text-sm font-semibold text-foreground">Evidence</div>
            <div className="mt-1 text-xs text-muted-foreground">
              User feedback stays linked to the generated proposal and final skill revision.
            </div>
          </div>
          <div className="space-y-2">
            {review.feedbackItems.map((item, index) => (
              <div key={item.id} className="rounded-lg border border-border/70 bg-background/60 px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] text-muted-foreground">Feedback {index + 1}</span>
                  <span className="text-[11px] text-muted-foreground">{item.sourceKind.replaceAll("_", " ")}</span>
                </div>
                <div className="mt-1 text-xs text-foreground">{item.body}</div>
                {item.selectedTextSnapshot ? (
                  <div className="mt-2 max-h-24 overflow-y-auto rounded-md bg-muted/30 p-2 text-[11px] text-muted-foreground">
                    {item.selectedTextSnapshot}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </aside>

        <section className="space-y-3">
          <div className="rounded-xl border border-border bg-[color:var(--surface-elevated)] p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <GitPullRequest className="h-4 w-4 text-muted-foreground" />
                  {primaryProposal?.title ?? "AI Skill Update Proposal"}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  Target skill: <span className="font-medium text-foreground">{targetSkillLabel}</span>
                </div>
              </div>
              {primaryProposal ? (
                <span className={cn("rounded-md border px-2 py-1 text-[11px] font-medium capitalize", proposalStatusClassName(primaryProposal.status))}>
                  {formatStatus(primaryProposal.status)}
                </span>
              ) : null}
            </div>

            {primaryProposal ? (
              <>
                <div className="mt-4 grid gap-3 md:grid-cols-3">
                  <div className="rounded-lg border border-border/70 bg-background/60 px-3 py-2 text-xs">
                    <div className="text-muted-foreground">Risk</div>
                    <div className="mt-1 font-medium capitalize text-foreground">{primaryProposal.riskLevel}</div>
                  </div>
                  <div className="rounded-lg border border-border/70 bg-background/60 px-3 py-2 text-xs">
                    <div className="text-muted-foreground">Base revision</div>
                    <div className="mt-1 font-mono text-foreground">{primaryProposal.baseRevisionId?.slice(0, 8) ?? "new"}</div>
                  </div>
                  <div className="rounded-lg border border-border/70 bg-background/60 px-3 py-2 text-xs">
                    <div className="text-muted-foreground">Patch</div>
                    <div className="mt-1 font-medium text-foreground">add active learnings</div>
                  </div>
                </div>

                {primaryProposal.summary ? (
                  <div className="mt-4 rounded-lg border border-border/70 bg-background/60 px-3 py-2">
                    <div className="text-xs font-medium text-muted-foreground">Summary</div>
                    <div className="mt-1 text-sm text-foreground">{primaryProposal.summary}</div>
                  </div>
                ) : null}

                {primaryProposal.rationale ? (
                  <div className="mt-3 rounded-lg border border-border/70 bg-background/60 px-3 py-2">
                    <div className="text-xs font-medium text-muted-foreground">Rationale</div>
                    <div className="mt-1 text-sm text-foreground">{primaryProposal.rationale}</div>
                  </div>
                ) : null}

                {primaryProposal.markdownDiff ? (
                  <div className="mt-3 rounded-lg border border-border/70 bg-muted/20 px-3 py-2">
                    <div className="text-xs font-medium text-muted-foreground">Proposed diff</div>
                    <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-foreground">
                      {primaryProposal.markdownDiff}
                    </pre>
                  </div>
                ) : null}

                {primaryProposal.expectedBehavior ? (
                  <div className="mt-3 rounded-lg border border-border/70 bg-background/60 px-3 py-2">
                    <div className="text-xs font-medium text-muted-foreground">Expected next-run behavior</div>
                    <div className="mt-1 whitespace-pre-wrap text-sm text-foreground">{primaryProposal.expectedBehavior}</div>
                  </div>
                ) : null}

                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <div className="rounded-lg border border-border/70 bg-background/60 px-3 py-2">
                    <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                      <ShieldCheck className="h-3.5 w-3.5" />
                      Validation and constraint checks
                    </div>
                    <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                      {primaryProposal.validationChecksJson.map((check) => (
                        <li key={check}>{check}</li>
                      ))}
                    </ul>
                  </div>
                  <div className="rounded-lg border border-border/70 bg-background/60 px-3 py-2">
                    <div className="text-xs font-medium text-muted-foreground">Rollback</div>
                    <div className="mt-2 text-xs text-muted-foreground">
                      {primaryProposal.rollbackPlan ?? "Reject before apply, or disable/revert the generated skill revision after apply."}
                    </div>
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
                  <div className="text-xs text-muted-foreground">
                    Human review approves the generated proposal; raw skill editing is an advanced path.
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5"
                      onClick={() => rejectProposal.mutate(primaryProposal.id)}
                      disabled={!proposalActionable || proposalBusy}
                    >
                      {rejectProposal.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <XCircle className="h-3.5 w-3.5" />}
                      Reject
                    </Button>
                    <Button
                      size="sm"
                      className="gap-1.5"
                      onClick={() => applyProposal.mutate(primaryProposal.id)}
                      disabled={!proposalActionable || proposalBusy}
                    >
                      {applyProposal.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                      Apply AI proposal
                    </Button>
                  </div>
                </div>
              </>
            ) : (
              <div className="mt-3 rounded-lg border border-border/70 bg-muted/20 px-3 py-3 text-sm text-muted-foreground">
                No generated skill proposal is linked to this feedback batch yet.
              </div>
            )}
          </div>

          <div className="rounded-xl border border-border bg-[color:var(--surface-elevated)] p-4">
            <div className="text-sm font-semibold">Normalized learnings</div>
            <div className="mt-1 text-xs text-muted-foreground">
              These are the Learning Builder's intermediate synthesis notes. They support the proposal, but are not the primary manual editing surface.
            </div>
            <div className="mt-3 space-y-2">
              {review.candidates.map((candidate: LearningCandidate) => (
                <div key={candidate.id} className="rounded-lg border border-border/70 bg-background/60 px-3 py-2">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <CircleDot className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <div className="text-sm font-medium text-foreground">{candidate.title}</div>
                    </div>
                    <span className={cn("rounded-md border px-2 py-1 text-[11px] font-medium capitalize", candidateStatusClassName(candidate.status))}>
                      {formatStatus(candidate.status)}
                    </span>
                  </div>
                  <div className="mt-2 text-sm text-foreground">{candidate.instruction}</div>
                  <div className="mt-2 grid gap-2 text-xs text-muted-foreground md:grid-cols-3">
                    <div>
                      <span className="font-medium text-foreground">Applies when: </span>
                      {formatRecord(candidate.appliesWhenJson)}
                    </div>
                    <div>
                      <span className="font-medium text-foreground">Classification: </span>
                      {formatStatus(candidate.classification)}
                    </div>
                    <div>
                      <span className="font-medium text-foreground">Risk: </span>
                      {candidate.riskLevel}
                    </div>
                  </div>
                  {candidate.mustNot ? (
                    <div className="mt-2 text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">Must not: </span>
                      {candidate.mustNot}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>

          {review.revisions.length > 0 ? (
            <div className="rounded-xl border border-border bg-[color:var(--surface-elevated)] p-4">
              <div className="text-sm font-semibold">Applied skill revisions</div>
              <div className="mt-2 space-y-2">
                {review.revisions.map((revision) => (
                  <div key={revision.id} className="flex items-center justify-between gap-3 rounded-lg border border-border/70 bg-background/60 px-3 py-2 text-xs">
                    <span>Revision {revision.revision}</span>
                    <StatusBadge status={revision.status} />
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
