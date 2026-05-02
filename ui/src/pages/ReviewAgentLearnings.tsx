import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CheckCircle2, CircleDot, Loader2, XCircle } from "lucide-react";
import type { LearningCandidate, UpdateLearningCandidateRequest } from "@rudderhq/shared";
import { agentLearningApi } from "../api/agentLearning";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { StatusBadge } from "../components/StatusBadge";
import { useOrganization } from "../context/OrganizationContext";
import { useToast } from "../context/ToastContext";
import { useViewedOrganization } from "../hooks/useViewedOrganization";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";

type CandidateDraft = {
  title: string;
  instruction: string;
  appliesWhen: string;
  mustNot: string;
};

function formatCandidateStatus(status: string) {
  switch (status) {
    case "approved":
      return "Approved";
    case "rejected":
      return "Rejected";
    case "one_off":
      return "One-off";
    case "applied":
      return "Applied";
    default:
      return "Pending";
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

function candidateToDraft(candidate: LearningCandidate): CandidateDraft {
  return {
    title: candidate.title,
    instruction: candidate.instruction,
    appliesWhen: JSON.stringify(candidate.appliesWhenJson ?? {}, null, 2),
    mustNot: candidate.mustNot ?? "",
  };
}

function parseDraft(candidate: LearningCandidate, draft: CandidateDraft): UpdateLearningCandidateRequest {
  let appliesWhenJson: Record<string, unknown>;
  try {
    const parsed = JSON.parse(draft.appliesWhen || "{}") as unknown;
    appliesWhenJson = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    throw new Error("Applies when must be valid JSON.");
  }

  return {
    title: draft.title,
    instruction: draft.instruction,
    appliesWhenJson,
    mustNot: draft.mustNot.trim() ? draft.mustNot.trim() : null,
    classification: candidate.classification,
    riskLevel: candidate.riskLevel,
    validationChecksJson: candidate.validationChecksJson,
  };
}

export function ReviewAgentLearnings() {
  const { agentId, batchId } = useParams<{ agentId?: string; batchId?: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { selectedOrganizationId } = useOrganization();
  const { viewedOrganizationId } = useViewedOrganization();
  const orgId = viewedOrganizationId ?? selectedOrganizationId;
  const { pushToast } = useToast();
  const [drafts, setDrafts] = useState<Record<string, CandidateDraft>>({});

  const reviewQuery = useQuery({
    queryKey: queryKeys.agentLearning.batchReview(orgId ?? "__none__", batchId ?? "__none__"),
    queryFn: () => agentLearningApi.batchReview(orgId!, batchId!),
    enabled: Boolean(orgId && batchId),
  });

  useEffect(() => {
    if (!reviewQuery.data) return;
    setDrafts((current) => {
      const next = { ...current };
      for (const candidate of reviewQuery.data.candidates) {
        if (!next[candidate.id]) next[candidate.id] = candidateToDraft(candidate);
      }
      return next;
    });
  }, [reviewQuery.data]);

  const invalidateReview = async () => {
    if (!orgId || !batchId) return;
    await queryClient.invalidateQueries({ queryKey: queryKeys.agentLearning.batchReview(orgId, batchId) });
  };

  const saveCandidate = useMutation({
    mutationFn: ({ candidate, draft }: { candidate: LearningCandidate; draft: CandidateDraft }) =>
      agentLearningApi.updateCandidate(orgId!, candidate.id, parseDraft(candidate, draft)),
    onSuccess: invalidateReview,
    onError: (error) => pushToast({
      title: "Could not save learning",
      body: error instanceof Error ? error.message : "Candidate update failed.",
      tone: "error",
    }),
  });

  const setCandidateStatus = useMutation({
    mutationFn: async ({ candidate, status }: { candidate: LearningCandidate; status: "approved" | "rejected" | "one_off" }) => {
      const draft = drafts[candidate.id];
      if (draft) {
        await agentLearningApi.updateCandidate(orgId!, candidate.id, parseDraft(candidate, draft));
      }
      if (status === "approved") return agentLearningApi.approveCandidate(orgId!, candidate.id);
      if (status === "rejected") return agentLearningApi.rejectCandidate(orgId!, candidate.id);
      return agentLearningApi.oneOffCandidate(orgId!, candidate.id);
    },
    onSuccess: invalidateReview,
    onError: (error) => pushToast({
      title: "Could not update learning",
      body: error instanceof Error ? error.message : "Learning status update failed.",
      tone: "error",
    }),
  });

  const applyApproved = useMutation({
    mutationFn: () => agentLearningApi.applyApproved(orgId!, batchId!),
    onSuccess: async (result) => {
      await Promise.all([
        invalidateReview(),
        queryClient.invalidateQueries({ queryKey: queryKeys.agentLearning.summary(orgId!, reviewQuery.data!.agent.id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.skills(reviewQuery.data!.agent.id) }),
      ]);
      pushToast({
        title: "Agent skill updated",
        body: result.skill
          ? `${result.skill.name} will load in future runs.`
          : "Approved learnings were applied.",
        tone: "success",
      });
      navigate(`/agents/${agentId ?? reviewQuery.data!.agent.urlKey}/skills`);
    },
    onError: (error) => pushToast({
      title: "Could not apply learnings",
      body: error instanceof Error ? error.message : "Apply failed.",
      tone: "error",
    }),
  });

  const review = reviewQuery.data;
  const approvedCount = useMemo(
    () => review?.candidates.filter((candidate) => candidate.status === "approved").length ?? 0,
    [review?.candidates],
  );

  if (!orgId || !batchId) {
    return <div className="mx-auto max-w-3xl py-10 text-sm text-muted-foreground">Missing learning review context.</div>;
  }

  if (reviewQuery.isLoading) {
    return <div className="mx-auto max-w-3xl py-10 text-sm text-muted-foreground">Loading learning review...</div>;
  }

  if (reviewQuery.isError || !review) {
    return (
      <div className="mx-auto max-w-3xl py-10 text-sm text-destructive">
        {reviewQuery.error instanceof Error ? reviewQuery.error.message : "Could not load learning review."}
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-6xl space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link
            to={`/agents/${agentId ?? review.agent.urlKey}/runs`}
            className="mb-2 inline-flex items-center gap-1.5 text-xs text-muted-foreground no-underline hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to runs
          </Link>
          <h1 className="text-xl font-semibold tracking-tight">Review what this agent should learn</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {review.feedbackItems.length} feedback item{review.feedbackItems.length === 1 ? "" : "s"} from run{" "}
            <span className="font-mono">{review.feedbackItems[0]?.runId.slice(0, 8) ?? review.batch.id.slice(0, 8)}</span>
            {" "}- Scope: {review.agent.name}
          </p>
        </div>
        <Button
          className="gap-2"
          onClick={() => applyApproved.mutate()}
          disabled={approvedCount === 0 || applyApproved.isPending}
        >
          {applyApproved.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
          Apply approved updates
        </Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[20rem_minmax(0,1fr)]">
        <aside className="space-y-3 rounded-xl border border-border bg-[color:var(--surface-elevated)] p-3">
          <div>
            <div className="text-sm font-semibold text-foreground">Evidence</div>
            <div className="mt-1 text-xs text-muted-foreground">
              Feedback remains linked to run evidence after the skill changes.
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
          {review.candidates.map((candidate) => {
            const draft = drafts[candidate.id] ?? candidateToDraft(candidate);
            const isApplied = candidate.status === "applied";
            const isBusy = isApplied || saveCandidate.isPending || setCandidateStatus.isPending;
            return (
              <div key={candidate.id} className="rounded-xl border border-border bg-[color:var(--surface-elevated)] p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <CircleDot className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <Input
                      value={draft.title}
                      onChange={(event) => setDrafts((current) => ({
                        ...current,
                        [candidate.id]: { ...draft, title: event.target.value },
                      }))}
                      disabled={isApplied}
                      className="h-8 border-transparent bg-transparent px-0 text-sm font-semibold shadow-none focus-visible:ring-0"
                    />
                  </div>
                  <span className={cn("rounded-md border px-2 py-1 text-[11px] font-medium", candidateStatusClassName(candidate.status))}>
                    {formatCandidateStatus(candidate.status)}
                  </span>
                </div>

                <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_15rem]">
                  <div className="space-y-2">
                    <label className="text-xs font-medium text-muted-foreground" htmlFor={`instruction-${candidate.id}`}>
                      Instruction
                    </label>
                    <Textarea
                      id={`instruction-${candidate.id}`}
                      value={draft.instruction}
                      onChange={(event) => setDrafts((current) => ({
                        ...current,
                        [candidate.id]: { ...draft, instruction: event.target.value },
                      }))}
                      disabled={isApplied}
                      className="min-h-28 text-sm"
                    />
                  </div>
                  <div className="space-y-2">
                    <div className="rounded-lg border border-border/70 bg-background/60 px-3 py-2 text-xs">
                      <div className="text-muted-foreground">Classification</div>
                      <div className="mt-1 font-medium text-foreground">{candidate.classification.replaceAll("_", " ")}</div>
                    </div>
                    <div className="rounded-lg border border-border/70 bg-background/60 px-3 py-2 text-xs">
                      <div className="text-muted-foreground">Risk</div>
                      <div className="mt-1 font-medium capitalize text-foreground">{candidate.riskLevel}</div>
                    </div>
                    <div className="rounded-lg border border-border/70 bg-background/60 px-3 py-2 text-xs">
                      <div className="text-muted-foreground">Target skill</div>
                      <div className="mt-1 font-medium text-foreground">
                        {review.targetSkill?.name ?? "Agent Learning"}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <div className="space-y-2">
                    <label className="text-xs font-medium text-muted-foreground" htmlFor={`applies-${candidate.id}`}>
                      Applies when
                    </label>
                    <Textarea
                      id={`applies-${candidate.id}`}
                      value={draft.appliesWhen}
                      onChange={(event) => setDrafts((current) => ({
                        ...current,
                        [candidate.id]: { ...draft, appliesWhen: event.target.value },
                      }))}
                      disabled={isApplied}
                      className="min-h-24 font-mono text-xs"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-medium text-muted-foreground" htmlFor={`must-not-${candidate.id}`}>
                      Must not
                    </label>
                    <Textarea
                      id={`must-not-${candidate.id}`}
                      value={draft.mustNot}
                      onChange={(event) => setDrafts((current) => ({
                        ...current,
                        [candidate.id]: { ...draft, mustNot: event.target.value },
                      }))}
                      disabled={isApplied}
                      className="min-h-24 text-xs"
                    />
                  </div>
                </div>

                <div className="mt-3 rounded-lg border border-border/70 bg-muted/20 px-3 py-2">
                  <div className="text-xs font-medium text-muted-foreground">Validation checks</div>
                  <ul className="mt-1 list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                    {candidate.validationChecksJson.map((check) => (
                      <li key={check}>{check}</li>
                    ))}
                  </ul>
                </div>

                <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                  <div className="text-xs text-muted-foreground">
                    {candidate.targetSkillReason ?? "Generated from run feedback."}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => saveCandidate.mutate({ candidate, draft })}
                      disabled={isBusy}
                    >
                      Save
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setCandidateStatus.mutate({ candidate, status: "one_off" })}
                      disabled={isBusy}
                    >
                      One-off
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5"
                      onClick={() => setCandidateStatus.mutate({ candidate, status: "rejected" })}
                      disabled={isBusy}
                    >
                      <XCircle className="h-3.5 w-3.5" />
                      Reject
                    </Button>
                    <Button
                      size="sm"
                      className="gap-1.5"
                      onClick={() => setCandidateStatus.mutate({ candidate, status: "approved" })}
                      disabled={isBusy}
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      Approve
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}

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
