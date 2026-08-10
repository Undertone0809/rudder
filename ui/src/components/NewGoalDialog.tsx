import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useNavigate } from "@/lib/router";
import type { GoalStartPreview } from "@rudderhq/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Calendar, Check, Circle, Loader2, Target, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { agentsApi } from "../api/agents";
import { goalsApi } from "../api/goals";
import { useDialog, type NewGoalDefaults } from "../context/DialogContext";
import { useOrganization } from "../context/OrganizationContext";
import { fromDateTimeLocalValue } from "../lib/datetime-local";
import { markdownDocumentOrUndefined } from "../lib/markdown-document-value";
import { queryKeys } from "../lib/queryKeys";
import { AgentMenuLabel } from "./AssigneeLabel";
import { InlineEntitySelector, type InlineEntityOption } from "./InlineEntitySelector";
import { MarkdownEditor, type MarkdownEditorRef } from "./MarkdownEditor";

type PreviewInput = {
  title: string;
  context: string | null;
  ownerAgentId: string | null;
  targetTime: string | null;
};

type GoalDialogAction = "save-draft" | "start";

const EMPTY_NEW_GOAL_DEFAULTS: NewGoalDefaults = {};

function useDebouncedValue<T>(value: T, delay: number) {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timeout);
  }, [delay, value]);

  return debounced;
}

function PreviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid min-w-0 gap-1 border-t border-border/60 py-2.5 first:border-t-0 sm:grid-cols-[9.5rem_minmax(0,1fr)] sm:gap-3">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="min-w-0 whitespace-pre-wrap break-words text-sm text-foreground">{value}</div>
    </div>
  );
}

export function NewGoalDialog() {
  const { newGoalOpen, newGoalDefaults = EMPTY_NEW_GOAL_DEFAULTS, closeNewGoal } = useDialog();
  const { selectedOrganizationId, selectedOrganization } = useOrganization();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [goal, setGoal] = useState("");
  const [context, setContext] = useState("");
  const [ownerAgentId, setOwnerAgentId] = useState("");
  const [targetTime, setTargetTime] = useState("");
  const [documentSessionId, setDocumentSessionId] = useState(0);
  const requestRef = useRef<{ identity: string; key: string } | null>(null);
  const contextRef = useRef<MarkdownEditorRef>(null);

  useEffect(() => {
    if (!newGoalOpen) return;
    setGoal(newGoalDefaults.title ?? "");
    setContext(newGoalDefaults.context ?? "");
    setOwnerAgentId(newGoalDefaults.ownerAgentId ?? "");
    setTargetTime(newGoalDefaults.targetTime ?? "");
    requestRef.current = null;
  }, [
    newGoalDefaults.context,
    newGoalDefaults.draftId,
    newGoalDefaults.ownerAgentId,
    newGoalDefaults.targetTime,
    newGoalDefaults.title,
    newGoalOpen,
  ]);

  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(selectedOrganizationId!),
    queryFn: () => agentsApi.list(selectedOrganizationId!),
    enabled: Boolean(newGoalOpen && selectedOrganizationId),
  });
  const agents = agentsQuery.data ?? [];
  const agentsLoaded = agentsQuery.isSuccess;

  const invokableAgents = useMemo(
    () => agents.filter((agent) => agent.status !== "terminated" && agent.status !== "pending_approval"),
    [agents],
  );

  useEffect(() => {
    if (!newGoalOpen || !agentsLoaded) return;
    if (ownerAgentId && !invokableAgents.some((agent) => agent.id === ownerAgentId)) setOwnerAgentId("");
  }, [agentsLoaded, invokableAgents, newGoalOpen, ownerAgentId]);

  const agentOptions = useMemo<InlineEntityOption[]>(
    () => invokableAgents.map((agent) => ({
      id: agent.id,
      label: agent.name,
      searchText: `${agent.name} ${agent.title ?? ""} ${agent.role}`,
    })),
    [invokableAgents],
  );
  const currentOwner = invokableAgents.find((agent) => agent.id === ownerAgentId) ?? null;

  const previewInput = useMemo<PreviewInput>(() => ({
    title: goal.trim(),
    context: markdownDocumentOrUndefined(context) ?? null,
    ownerAgentId: ownerAgentId || null,
    targetTime: fromDateTimeLocalValue(targetTime),
  }), [context, goal, ownerAgentId, targetTime]);
  const debouncedPreviewInput = useDebouncedValue(previewInput, 250);
  const currentPreviewFingerprint = JSON.stringify(previewInput);
  const previewFingerprint = JSON.stringify(debouncedPreviewInput);
  const previewQuery = useQuery({
    queryKey: ["goals", "start-preview", selectedOrganizationId, previewFingerprint],
    queryFn: () => goalsApi.previewStart(selectedOrganizationId!, debouncedPreviewInput),
    enabled: Boolean(newGoalOpen && selectedOrganizationId && debouncedPreviewInput.title),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });

  const preview = previewQuery.data;
  const previewIsCurrent = currentPreviewFingerprint === previewFingerprint;
  const previewCanStart = Boolean(preview?.valid && preview.packet && preview.packetHash);
  const canStart = previewIsCurrent && previewCanStart;

  const requestKeyFor = (candidate: GoalStartPreview) => {
    const identity = `${previewFingerprint}:${candidate.packetHash ?? "draft"}`;
    if (requestRef.current?.identity !== identity) {
      requestRef.current = { identity, key: crypto.randomUUID() };
    }
    return requestRef.current.key;
  };

  const reset = () => {
    setDocumentSessionId((current) => current + 1);
    setGoal("");
    setContext("");
    setOwnerAgentId("");
    setTargetTime("");
    requestRef.current = null;
  };

  const close = () => {
    reset();
    closeNewGoal();
  };

  const createGoal = useMutation({
    mutationFn: async (action: GoalDialogAction) => {
      if (!selectedOrganizationId) throw new Error("Select an organization before creating a Goal.");
      if (action === "start") {
        if (!previewIsCurrent) throw new Error("Goal details changed. Wait for the latest preview before continuing.");
        if (!preview || !canStart || !preview.packet || !preview.packetHash) {
          throw new Error("Complete the start requirements before starting this Goal.");
        }
        return goalsApi.start(selectedOrganizationId, {
          requestKey: requestKeyFor(preview),
          packetHash: preview.packetHash,
          packet: preview.packet,
          ...(preview.warning ? { allowCapabilityMismatch: true } : {}),
          ...(newGoalDefaults.draftId ? { draftGoalId: newGoalDefaults.draftId } : {}),
        });
      }
      if (newGoalDefaults.draftId) {
        return goalsApi.update(newGoalDefaults.draftId, {
          title: goal.trim(),
          description: markdownDocumentOrUndefined(context),
          ownerAgentId: ownerAgentId || null,
          targetTime: fromDateTimeLocalValue(targetTime),
          alignmentQuestion: preview?.alignmentQuestion,
        });
      }
      return goalsApi.create(selectedOrganizationId, {
        title: goal.trim(),
        description: markdownDocumentOrUndefined(context),
        ownerAgentId: ownerAgentId || null,
        targetTime: fromDateTimeLocalValue(targetTime),
        alignmentQuestion: preview?.alignmentQuestion,
      });
    },
    onSuccess: (createdGoal) => {
      if (selectedOrganizationId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.goals.list(selectedOrganizationId) });
        queryClient.invalidateQueries({ queryKey: ["goals", "workspace", selectedOrganizationId] });
      }
      const goalId = createdGoal.id;
      reset();
      closeNewGoal();
      navigate(`/goals/${goalId}`);
    },
  });

  const startDisabled =
    !goal.trim()
    || !previewIsCurrent
    || !canStart
    || previewQuery.isFetching
    || agentsQuery.isPending
    || agentsQuery.isError
    || (!preview && !previewQuery.error)
    || createGoal.isPending;
  const saveDisabled =
    !goal.trim()
    || createGoal.isPending
    || previewQuery.isFetching
    || (!previewIsCurrent && !previewQuery.error)
    || (!preview && !previewQuery.error);
  const previewBlockers = preview?.blockers ?? [];
  const outcomeReady = Boolean(
    canStart
    || previewBlockers.every((blocker) => blocker.code !== "outcome_required"),
  );
  const ownerReady = Boolean(currentOwner && previewBlockers.every((blocker) => blocker.code !== "owner_required"));
  const unresolvedCount = Number(!outcomeReady) + Number(!ownerReady);

  return (
    <Dialog open={newGoalOpen} onOpenChange={(open) => !open && close()}>
      <DialogContent
        showCloseButton={false}
        className="grid-rows-[auto_minmax(0,1fr)_auto] max-h-[min(46rem,calc(100dvh-2rem))] gap-0 overflow-hidden p-0 sm:max-w-2xl"
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            if (!startDisabled) createGoal.mutate("start");
          }
        }}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs font-medium">
              {selectedOrganization?.name.slice(0, 3).toUpperCase()}
            </span>
            <span aria-hidden="true">/</span>
            <div className="min-w-0">
              <DialogTitle className="truncate text-sm font-medium text-foreground">
                {newGoalDefaults.draftId ? "Continue Goal" : "New Goal"}
              </DialogTitle>
              <DialogDescription className="sr-only">
                Describe the outcome you want and choose the Agent who should advance it.
              </DialogDescription>
            </div>
          </div>
          <Button type="button" variant="ghost" size="icon-xs" aria-label="Close" onClick={close} disabled={createGoal.isPending}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>

        <div className="scrollbar-auto-hide min-h-0 overflow-x-hidden overflow-y-auto px-4 py-4">
          <div className="space-y-4">
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">Goal</span>
              <textarea
                aria-label="Goal"
                className="min-h-16 w-full resize-none overflow-hidden rounded-md border border-border bg-background px-3 py-2 text-base font-medium outline-none placeholder:text-muted-foreground/55 focus:border-ring"
                placeholder="What should become true?"
                rows={2}
                value={goal}
                onChange={(event) => {
                  setGoal(event.target.value);
                  event.target.style.height = "auto";
                  event.target.style.height = `${event.target.scrollHeight}px`;
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
                    event.preventDefault();
                    contextRef.current?.focus();
                  }
                }}
                autoFocus
              />
            </label>

            <div className="space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">Context</span>
              <MarkdownEditor
                ref={contextRef}
                engine="codemirror"
                documentIdentity={`new-goal:${selectedOrganizationId ?? "none"}:${newGoalDefaults.draftId ?? documentSessionId}`}
                ariaLabel="Context"
                placeholder="Optional background or why this matters now"
                value={context}
                onChange={setContext}
                contentClassName="min-h-20 text-sm"
              />
            </div>

            <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="min-w-0 space-y-1.5">
                <div className="text-xs font-medium text-muted-foreground">Assignee</div>
                <InlineEntitySelector
                  value={ownerAgentId}
                  options={agentOptions}
                  placeholder="Select an Agent"
                  noneLabel="No assignee"
                  searchPlaceholder="Search Agents..."
                  emptyMessage={agentsQuery.isError ? "Agents could not be loaded." : "No available Agents."}
                  ariaLabel="Assignee"
                  variant="field"
                  side="top"
                  onChange={setOwnerAgentId}
                  renderTriggerValue={(option) => option && currentOwner
                    ? <AgentMenuLabel agent={currentOwner} agentAvatarStyle="bare" />
                    : <span className="text-muted-foreground">No assignee</span>}
                  renderOption={(option, isSelected) => {
                    const agent = agents.find((candidate) => candidate.id === option.id);
                    return (
                      <span role="option" aria-selected={isSelected} className="flex min-w-0 flex-1">
                        {agent
                          ? <AgentMenuLabel agent={agent} agentAvatarStyle="bare" />
                          : <span className="truncate">{option.label}</span>}
                      </span>
                    );
                  }}
                />
                {agentsQuery.isSuccess && invokableAgents.length === 0 ? (
                  <p role="status" className="text-xs leading-5 text-muted-foreground">
                    No available Agents yet. Add or activate an Agent before starting this Goal.
                    <button
                      type="button"
                      className="ml-1 underline underline-offset-2 hover:text-foreground"
                      onClick={() => {
                        close();
                        navigate("/agents");
                      }}
                    >
                      Open Agents
                    </button>
                  </p>
                ) : null}
              </div>
              <label className="min-w-0 space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">Target time</span>
                <span className="flex h-10 min-w-0 items-center gap-2 rounded-md border border-border bg-background px-3 focus-within:border-ring">
                  <Calendar className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <input
                    aria-label="Target time"
                    type="datetime-local"
                    className="min-w-0 flex-1 bg-transparent text-sm outline-none"
                    value={targetTime}
                    onChange={(event) => setTargetTime(event.target.value)}
                  />
                </span>
              </label>
            </div>

            {goal.trim() ? (
              <section aria-label="Goal start preview" className="border-y border-border">
                {previewQuery.isFetching ? (
                  <div className="flex min-h-24 items-center justify-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Preparing preview...
                  </div>
                ) : preview?.review ? (
                  <div>
                    <div className="flex items-center gap-2 border-b border-border/60 py-2.5 text-sm font-medium text-emerald-700 dark:text-emerald-400">
                      <Check className="h-4 w-4" />
                      Ready to start
                    </div>
                    {preview.warning ? (
                      <div role="alert" className="border-b border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-sm leading-5 text-foreground">
                        {preview.warning}
                      </div>
                    ) : null}
                    <PreviewRow label="Outcome" value={preview.review.outcome} />
                    <PreviewRow label="How we will know it worked" value={preview.review.success} />
                    <PreviewRow label="Owner" value={currentOwner?.name ?? preview.review.owner ?? "No Agent selected"} />
                    <PreviewRow label="Boundary" value={preview.review.boundary} />
                    <PreviewRow label="First action" value={preview.review.firstAction} />
                  </div>
                ) : preview ? (
                  <div className="py-3">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <Target className="h-4 w-4 shrink-0 text-muted-foreground" />
                      Complete before starting
                    </div>
                    <div className="mt-2 divide-y divide-border/60 border-y border-border/60">
                      <div className="flex min-w-0 items-start gap-2 py-2.5 text-sm">
                        {outcomeReady
                          ? <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700 dark:text-emerald-400" />
                          : <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />}
                        <div className="min-w-0">
                          <div className="font-medium">Verifiable result</div>
                          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                            {previewBlockers.find((blocker) => blocker.code === "outcome_required")?.message
                              ?? "The Goal describes a result or decision that can be reviewed."}
                          </p>
                        </div>
                      </div>
                      <div className="flex min-w-0 items-start gap-2 py-2.5 text-sm">
                        {ownerReady
                          ? <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700 dark:text-emerald-400" />
                          : <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />}
                        <div className="min-w-0">
                          <div className="font-medium">Owner Agent</div>
                          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                            {previewBlockers.find((blocker) => blocker.code === "owner_required")?.message
                              ?? (currentOwner ? `${currentOwner.name} will own and start this Goal.` : "Select an available Agent to own and start this Goal.")}
                          </p>
                        </div>
                      </div>
                    </div>
                    {preview.alignmentQuestion ? (
                      <p className="mt-2 text-xs leading-5 text-muted-foreground">Next: {preview.alignmentQuestion}</p>
                    ) : null}
                  </div>
                ) : null}
              </section>
            ) : null}

            {previewQuery.error ? (
              <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
                <span>{previewQuery.error.message}</span>
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto p-0 text-sm"
                  onClick={() => void previewQuery.refetch()}
                  disabled={previewQuery.isFetching || createGoal.isPending}
                >
                  Retry preview
                </Button>
              </div>
            ) : null}
            {agentsQuery.isError ? (
              <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
                <span>Available Agents could not be loaded. Try again before starting this Goal.</span>
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto p-0 text-sm"
                  onClick={() => void agentsQuery.refetch()}
                  disabled={agentsQuery.isFetching || createGoal.isPending}
                >
                  Retry Agents
                </Button>
              </div>
            ) : null}
            {createGoal.error ? (
              <p role="alert" className="text-sm text-destructive">
                {createGoal.variables === "save-draft" ? "Unable to save this draft right now. Try again." : "Unable to start this Goal right now. Try again."}
              </p>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-2.5">
          <span className="text-xs text-muted-foreground">
            {goal.trim() && unresolvedCount > 0 ? `${unresolvedCount} ${unresolvedCount === 1 ? "requirement" : "requirements"} left to start` : ""}
          </span>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" disabled={saveDisabled} onClick={() => createGoal.mutate("save-draft")}>
              {createGoal.isPending && createGoal.variables === "save-draft" ? "Saving..." : "Save draft"}
            </Button>
            <Button type="button" size="sm" disabled={startDisabled} onClick={() => createGoal.mutate("start")}>
              {createGoal.isPending && createGoal.variables === "start" ? "Starting..." : "Start Goal"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
