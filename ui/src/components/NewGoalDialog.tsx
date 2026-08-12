import { Button } from "@/components/ui/button";
import { Calendar as DateCalendar } from "@/components/ui/calendar";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useNavigate } from "@/lib/router";
import type { GoalStartPreview } from "@rudderhq/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, Calendar, Check, Circle, Clock3, Loader2, Target, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { agentsApi } from "../api/agents";
import { assetsApi } from "../api/assets";
import { goalsApi } from "../api/goals";
import { useDialog, type NewGoalDefaults } from "../context/DialogContext";
import { useOrganization } from "../context/OrganizationContext";
import { fromDateTimeLocalValue, toDateTimeLocalValue } from "../lib/datetime-local";
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

const padTimePart = (value: number) => String(value).padStart(2, "0");

function parseTargetTime(value: string) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatTargetTime(value: string) {
  const date = parseTargetTime(value);
  if (!date) return "Set a target time";
  return `${date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })} at ${padTimePart(date.getHours())}:${padTimePart(date.getMinutes())}`;
}

function isNestedSelectTarget(target: EventTarget | null) {
  return target instanceof HTMLElement && Boolean(target.closest('[data-slot="select-content"]'));
}

function GoalTargetTimePicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const selected = parseTargetTime(value);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Date | null>(selected);
  const draftTime = draft ?? new Date();

  useEffect(() => {
    setDraft(selected);
  }, [value]);

  const updateDraft = (next: Date | null) => {
    setDraft(next);
  };

  const chooseDate = (date: Date | undefined) => {
    if (!date) return;
    const next = new Date(date);
    next.setHours(draftTime.getHours(), draftTime.getMinutes(), 0, 0);
    updateDraft(next);
  };

  const chooseTime = (part: "hours" | "minutes", rawValue: string) => {
    const next = new Date(draftTime);
    next.setSeconds(0, 0);
    next[part === "hours" ? "setHours" : "setMinutes"](Number(rawValue));
    updateDraft(next);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) setDraft(selected);
    setOpen(nextOpen);
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Target time"
          className="flex min-h-12 min-w-0 w-full items-center gap-2 rounded-md border border-border bg-background px-3 text-left text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
        >
          <Calendar className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className={selected ? "min-w-0 flex-1 truncate text-foreground" : "min-w-0 flex-1 truncate text-muted-foreground"}>
            {formatTargetTime(value)}
          </span>
          <Clock3 className="h-4 w-4 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        collisionPadding={8}
        className="max-h-[calc(100dvh-1rem)] w-auto max-w-[calc(100vw-2rem)] overflow-y-auto p-0"
        onInteractOutside={(event) => {
          if (isNestedSelectTarget(event.target)) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (isNestedSelectTarget(event.target)) event.preventDefault();
        }}
      >
        <div className="flex flex-col gap-2 p-2 sm:gap-3 sm:p-3 sm:flex-row">
          <DateCalendar
            mode="single"
            selected={draft ?? undefined}
            onSelect={chooseDate}
            defaultMonth={draft ?? new Date()}
            initialFocus
            className="max-sm:!p-2 max-sm:[--cell-size:1.75rem]"
          />
          <div className="flex min-w-44 flex-col gap-2 border-t border-border pt-2 sm:gap-3 sm:border-t-0 sm:border-l sm:pl-3 sm:pt-0">
            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <Clock3 className="h-3.5 w-3.5" />
              Time
            </div>
            <div className="grid grid-cols-2 gap-2">
              <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
                Hour
                <Select value={padTimePart(draftTime.getHours())} onValueChange={(next) => chooseTime("hours", next)}>
                  <SelectTrigger aria-label="Target hour" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent position="popper" align="start" className="max-h-56"><SelectGroup>{Array.from({ length: 24 }, (_, hour) => <SelectItem key={hour} value={padTimePart(hour)}>{padTimePart(hour)}</SelectItem>)}</SelectGroup></SelectContent>
                </Select>
              </label>
              <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
                Minute
                <Select value={padTimePart(draftTime.getMinutes())} onValueChange={(next) => chooseTime("minutes", next)}>
                  <SelectTrigger aria-label="Target minute" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent position="popper" align="start" className="max-h-56"><SelectGroup>{Array.from({ length: 60 }, (_, minute) => <SelectItem key={minute} value={padTimePart(minute)}>{padTimePart(minute)}</SelectItem>)}</SelectGroup></SelectContent>
                </Select>
              </label>
            </div>
            <div className="mt-auto flex items-center justify-between gap-2 border-t border-border pt-3">
              <Button type="button" variant="ghost" size="sm" onClick={() => { setDraft(null); onChange(""); setOpen(false); }}>Clear</Button>
              <Button type="button" size="sm" onClick={() => { if (draft) onChange(toDateTimeLocalValue(draft)); setOpen(false); }} disabled={!draft}>Done</Button>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
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
        className="h-[calc(100dvh-1.5rem)] max-h-[calc(100dvh-1.5rem)] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 sm:h-[min(46rem,calc(100dvh-2rem))] sm:max-h-[min(46rem,calc(100dvh-2rem))] sm:max-w-3xl"
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

              <div className="px-4 pb-4">
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
                        <PreviewRow label="Owner" value={currentOwner?.name ?? preview.review.owner ?? "No Agent selected"} />
                        <PreviewRow label="Boundary" value={preview.review.boundary} />
                        <PreviewRow label="Success criteria" value={preview.review.success} />
                        <PreviewRow label="First action" value={preview.review.firstAction} />
                      </div>
                    ) : preview ? (
                      <div className="py-2.5">
                        <div className="flex items-center gap-2 text-sm font-medium">
                          <Target className="h-4 w-4 shrink-0 text-muted-foreground" />
                          Complete before starting
                        </div>
                        <div className="mt-2 divide-y divide-border/60 border-y border-border/60">
                          <button
                            type="button"
                            aria-label={outcomeReady ? "Expected result complete" : "Add expected result"}
                            className="flex w-full min-w-0 items-start gap-2 py-2.5 text-left text-sm disabled:cursor-default"
                            disabled={outcomeReady}
                            onClick={() => contextRef.current?.focus()}
                          >
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
                            {!outcomeReady ? (
                              <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-xs font-medium text-foreground">
                                Add above <ArrowUp className="h-3.5 w-3.5" />
                              </span>
                            ) : null}
                          </button>
                          <button
                            type="button"
                            aria-label={ownerReady ? "Owner Agent complete" : "Choose Owner Agent"}
                            className="flex w-full min-w-0 items-start gap-2 py-2.5 text-left text-sm disabled:cursor-default"
                            disabled={ownerReady}
                            onClick={() => ownerSelectorRef.current?.focus()}
                          >
                            {ownerReady
                              ? <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700 dark:text-emerald-400" />
                              : <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />}
                            <div className="min-w-0">
                              <div className="font-medium">Owner Agent</div>
                              <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                                {currentOwner
                                  ? `${currentOwner.name} will own and start this Goal.`
                                  : "Select an Agent above to own and start this Goal."}
                              </p>
                            </div>
                            {!ownerReady ? (
                              <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-xs font-medium text-foreground">
                                Choose <ArrowUp className="h-3.5 w-3.5" />
                              </span>
                            ) : null}
                          </button>
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
        </div>

        <div className="relative z-10 flex flex-wrap items-center justify-between gap-2 border-t border-border bg-card px-4 py-3">
          <span className="text-xs text-muted-foreground">
            {goal.trim() && unresolvedCount > 0 ? `${unresolvedCount} ${unresolvedCount === 1 ? "requirement" : "requirements"} left to start` : ""}
          </span>
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
