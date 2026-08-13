import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useNavigate } from "@/lib/router";
import type { GoalStartPreview } from "@rudderhq/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { agentsApi } from "../api/agents";
import { assetsApi } from "../api/assets";
import { goalsApi } from "../api/goals";
import { useDialog, type NewGoalDefaults } from "../context/DialogContext";
import { useOrganization } from "../context/OrganizationContext";
import { fromDateTimeLocalValue } from "../lib/datetime-local";
import { markdownDocumentOrUndefined } from "../lib/markdown-document-value";
import { queryKeys } from "../lib/queryKeys";
import { AgentMenuLabel } from "./AssigneeLabel";
import { GoalTargetTimePicker } from "./GoalTargetTimePicker";
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
  const ownerSelectorRef = useRef<HTMLButtonElement>(null);
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
  const uploadContextImage = useMutation({
    mutationFn: async (file: File) => {
      if (!selectedOrganizationId) throw new Error("No organization selected");
      return assetsApi.uploadImage(selectedOrganizationId, file, "goals/drafts");
    },
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
  return (
    <Dialog open={newGoalOpen} onOpenChange={(open) => !open && close()}>
      <DialogContent
        showCloseButton={false}
        className="motion-modal-no-scale h-[calc(100dvh-1.5rem)] max-h-[calc(100dvh-1.5rem)] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 sm:h-[min(46rem,calc(100dvh-2rem))] sm:max-h-[min(46rem,calc(100dvh-2rem))] sm:max-w-3xl"
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

        <div className="scrollbar-auto-hide min-h-0 overscroll-contain overflow-x-hidden overflow-y-auto">
          <div>
            <label className="block px-4 pt-4 pb-2">
              <span className="sr-only">Goal</span>
              <input
                aria-label="Goal"
                className="h-9 w-full min-w-0 bg-transparent text-lg font-semibold leading-7 outline-none placeholder:text-muted-foreground/50"
                placeholder="Goal title"
                value={goal}
                onChange={(event) => setGoal(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
                    event.preventDefault();
                    contextRef.current?.focus();
                  }
                }}
                autoFocus
              />
            </label>

            <div className="grid min-w-0 grid-cols-1 gap-2 px-4 pb-3 sm:grid-cols-2">
              <div className="min-w-0 space-y-1.5">
                <div className="text-xs font-medium text-muted-foreground">Assignee</div>
                <InlineEntitySelector
                  ref={ownerSelectorRef}
                  value={ownerAgentId}
                  options={agentOptions}
                  placeholder="Select an Agent"
                  noneLabel="No assignee"
                  searchPlaceholder="Search Agents..."
                  emptyMessage={agentsQuery.isError ? "Agents could not be loaded." : "No available Agents."}
                  ariaLabel="Assignee"
                  variant="field"
                  className="h-auto min-h-12 w-full py-2"
                  side="bottom"
                  disablePortal
                  contentClassName="z-[80] max-h-60"
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
              <div className="min-w-0 space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">Target time</span>
                <GoalTargetTimePicker value={targetTime} onChange={setTargetTime} />
              </div>
            </div>

            <div className="min-h-0 border-t border-border/60 px-4 pt-3 pb-2">
              <span className="sr-only">Expected result</span>
              <MarkdownEditor
                ref={contextRef}
                engine="codemirror"
                documentIdentity={`new-goal:${selectedOrganizationId ?? "none"}:${newGoalDefaults.draftId ?? documentSessionId}`}
                ariaLabel="Expected result"
                placeholder="Describe the expected result and how someone will verify it..."
                value={context}
                onChange={setContext}
                bordered={false}
                contentClassName="min-h-[88px] w-full pb-12 text-sm text-muted-foreground"
                imageUploadHandler={async (file) => {
                  const asset = await uploadContextImage.mutateAsync(file);
                  return asset.contentPath;
                }}
              />
            </div>

              {previewQuery.error || agentsQuery.isError || createGoal.error ? (
                <div className="px-4 pb-4">
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
              ) : null}
          </div>
        </div>

        <div className="relative z-10 flex flex-wrap items-center justify-end gap-2 border-t border-border bg-card px-4 py-3">
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" className="text-muted-foreground" disabled={saveDisabled} onClick={() => createGoal.mutate("save-draft")}>
              {createGoal.isPending && createGoal.variables === "save-draft" ? "Saving..." : "Save draft"}
            </Button>
            <Button
              type="button"
              size="sm"
              className="min-w-28 disabled:border-border disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100 disabled:shadow-none"
              disabled={startDisabled}
              onClick={() => createGoal.mutate("start")}
            >
              {createGoal.isPending && createGoal.variables === "start" ? "Starting..." : "Start Goal"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
