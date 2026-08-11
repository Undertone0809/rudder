import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useNavigate } from "@/lib/router";
import type { GoalStartPreview } from "@rudderhq/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Calendar, Loader2, Target, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { agentsApi } from "../api/agents";
import { assetsApi } from "../api/assets";
import { goalsApi } from "../api/goals";
import { useDialog, type NewGoalDefaults } from "../context/DialogContext";
import { useOrganization } from "../context/OrganizationContext";
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

const EMPTY_NEW_GOAL_DEFAULTS: NewGoalDefaults = {};

function useDebouncedValue<T>(value: T, delay: number) {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timeout);
  }, [delay, value]);

  return debounced;
}

function toIsoTargetTime(value: string) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
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
  const contextEditorRef = useRef<MarkdownEditorRef>(null);

  useEffect(() => {
    if (!newGoalOpen) return;
    setGoal(newGoalDefaults.title ?? "");
    setContext(newGoalDefaults.context ?? "");
    setOwnerAgentId(newGoalDefaults.ownerAgentId ?? "");
    setTargetTime(newGoalDefaults.targetTime ?? "");
    requestRef.current = null;
  }, [newGoalDefaults, newGoalOpen]);

  const { data: agents = [] } = useQuery({
    queryKey: queryKeys.agents.list(selectedOrganizationId!),
    queryFn: () => agentsApi.list(selectedOrganizationId!),
    enabled: Boolean(newGoalOpen && selectedOrganizationId),
  });
  const uploadContextImage = useMutation({
    mutationFn: async (file: File) => {
      if (!selectedOrganizationId) throw new Error("No organization selected");
      return assetsApi.uploadImage(selectedOrganizationId, file, "goals/drafts");
    },
  });

  useEffect(() => {
    if (!newGoalOpen || ownerAgentId || agents.length === 0) return;
    const suggested = agents.find((agent) => agent.status !== "paused") ?? agents[0];
    setOwnerAgentId(suggested?.id ?? "");
  }, [agents, newGoalOpen, ownerAgentId]);

  const agentOptions = useMemo<InlineEntityOption[]>(
    () => agents.map((agent) => ({
      id: agent.id,
      label: agent.name,
      searchText: `${agent.name} ${agent.title ?? ""} ${agent.role}`,
    })),
    [agents],
  );
  const currentOwner = agents.find((agent) => agent.id === ownerAgentId) ?? null;

  const previewInput = useMemo<PreviewInput>(() => ({
    title: goal.trim(),
    context: markdownDocumentOrUndefined(context) ?? null,
    ownerAgentId: ownerAgentId || null,
    targetTime: toIsoTargetTime(targetTime),
  }), [context, goal, ownerAgentId, targetTime]);
  const debouncedPreviewInput = useDebouncedValue(previewInput, 250);
  const previewFingerprint = JSON.stringify(debouncedPreviewInput);
  const previewQuery = useQuery({
    queryKey: ["goals", "start-preview", selectedOrganizationId, previewFingerprint],
    queryFn: () => goalsApi.previewStart(selectedOrganizationId!, debouncedPreviewInput),
    enabled: Boolean(newGoalOpen && selectedOrganizationId && debouncedPreviewInput.title),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });

  const preview = previewQuery.data;
  const canStart = Boolean(preview?.valid && preview.packet && preview.packetHash);

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
    mutationFn: async () => {
      if (!selectedOrganizationId) throw new Error("Select an organization before creating a Goal.");
      if (preview && canStart && preview.packet && preview.packetHash) {
        return goalsApi.start(selectedOrganizationId, {
          requestKey: requestKeyFor(preview),
          packetHash: preview.packetHash,
          packet: preview.packet,
          ...(newGoalDefaults.draftId ? { draftGoalId: newGoalDefaults.draftId } : {}),
        });
      }
      if (newGoalDefaults.draftId) {
        return goalsApi.update(newGoalDefaults.draftId, {
          title: goal.trim(),
          description: markdownDocumentOrUndefined(context),
          alignmentQuestion: preview?.alignmentQuestion,
        });
      }
      return goalsApi.create(selectedOrganizationId, {
        title: goal.trim(),
        description: markdownDocumentOrUndefined(context),
        ownerAgentId: ownerAgentId || null,
        targetTime: toIsoTargetTime(targetTime),
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

  const actionLabel = canStart ? "Create and start" : "Save draft";
  const pendingLabel = canStart ? "Starting..." : "Saving...";
  const actionDisabled =
    !goal.trim()
    || previewQuery.isFetching
    || (!preview && !previewQuery.error)
    || createGoal.isPending;

  return (
    <Dialog open={newGoalOpen} onOpenChange={(open) => !open && close()}>
      <DialogContent
        showCloseButton={false}
        className="max-h-[min(46rem,calc(100dvh-2rem))] gap-0 overflow-hidden p-0 sm:max-w-2xl"
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            if (!actionDisabled) createGoal.mutate();
          }
        }}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs font-medium">
              {selectedOrganization?.name.slice(0, 3).toUpperCase()}
            </span>
            <span aria-hidden="true">/</span>
            <DialogTitle className="truncate text-sm font-medium text-foreground">New Goal</DialogTitle>
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
                    contextEditorRef.current?.focus();
                  }
                }}
                autoFocus
              />
            </label>

            <div className="block space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">Context</span>
              <MarkdownEditor
                ref={contextEditorRef}
                engine="codemirror"
                documentIdentity={`new-goal:${selectedOrganizationId ?? "none"}:${documentSessionId}`}
                placeholder="Optional background or why this matters now"
                value={context}
                onChange={setContext}
                bordered={false}
                contentClassName="min-h-20 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground/55 focus-within:border-ring"
                imageUploadHandler={async (file) => {
                  const asset = await uploadContextImage.mutateAsync(file);
                  return asset.contentPath;
                }}
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
                  emptyMessage="No Agents found."
                  ariaLabel="Assignee"
                  variant="field"
                  disablePortal
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
                    <PreviewRow label="Outcome" value={preview.review.outcome} />
                    <PreviewRow label="How we will know it worked" value={preview.review.success} />
                    <PreviewRow label="Owner" value={currentOwner?.name ?? preview.review.owner ?? "No Agent selected"} />
                    <PreviewRow label="Boundary" value={preview.review.boundary} />
                    <PreviewRow label="First action" value={preview.review.firstAction} />
                  </div>
                ) : preview?.alignmentQuestion ? (
                  <div className="flex min-w-0 gap-3 py-3">
                    <Target className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-muted-foreground">Needs alignment</div>
                      <p className="mt-1 whitespace-pre-wrap break-words text-sm">{preview.alignmentQuestion}</p>
                    </div>
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
            {createGoal.error ? <p role="alert" className="text-sm text-destructive">{createGoal.error.message}</p> : null}
          </div>
        </div>

        <div className="flex items-center justify-end border-t border-border px-4 py-2.5">
          <Button type="button" size="sm" disabled={actionDisabled} onClick={() => createGoal.mutate()}>
            {createGoal.isPending ? pendingLabel : actionLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
