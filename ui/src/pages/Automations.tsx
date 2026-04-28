import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { ArrowRight, CircleHelp, FolderOpen, MoreHorizontal, Play, Plus, Repeat, User } from "lucide-react";
import { automationsApi } from "../api/automations";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { useOrganization } from "../context/OrganizationContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { formatChatAgentLabel } from "../lib/agent-labels";
import { projectColorBackgroundStyle } from "../lib/project-colors";
import { queryKeys } from "../lib/queryKeys";
import { getRecentAssigneeIds, sortAgentsByRecency, trackRecentAssignee } from "../lib/recent-assignees";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgentIcon } from "../components/AgentIconPicker";
import { InlineEntitySelector, type InlineEntityOption } from "../components/InlineEntitySelector";
import { MarkdownEditor, type MarkdownEditorRef } from "../components/MarkdownEditor";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

const concurrencyPolicies = ["coalesce_if_active", "always_enqueue", "skip_if_active"];
const catchUpPolicies = ["skip_missed", "enqueue_missed_with_cap"];
const concurrencyPolicyDescriptions: Record<string, string> = {
  coalesce_if_active: "If a run is already active, keep just one follow-up run queued.",
  always_enqueue: "Queue every trigger occurrence, even if the automation is already running.",
  skip_if_active: "Drop new trigger occurrences while a run is still active.",
};
const catchUpPolicyDescriptions: Record<string, string> = {
  skip_missed: "Ignore windows that were missed while the scheduler or automation was paused.",
  enqueue_missed_with_cap: "Catch up missed schedule windows in capped batches after recovery.",
};

function autoResizeTextarea(element: HTMLTextAreaElement | null) {
  if (!element) return;
  element.style.height = "auto";
  element.style.height = `${element.scrollHeight}px`;
}

function formatLastRunTimestamp(value: Date | string | null | undefined) {
  if (!value) return "Never";
  return new Date(value).toLocaleString();
}

function nextAutomationStatus(currentStatus: string, enabled: boolean) {
  if (currentStatus === "archived" && enabled) return "active";
  return enabled ? "active" : "paused";
}

export function Automations() {
  const { selectedOrganizationId } = useOrganization();
  const { setBreadcrumbs, setHeaderActions } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { pushToast } = useToast();
  const descriptionEditorRef = useRef<MarkdownEditorRef>(null);
  const titleInputRef = useRef<HTMLTextAreaElement | null>(null);
  const assigneeSelectorRef = useRef<HTMLButtonElement | null>(null);
  const projectSelectorRef = useRef<HTMLButtonElement | null>(null);
  const [runningAutomationId, setRunningAutomationId] = useState<string | null>(null);
  const [statusMutationAutomationId, setStatusMutationAutomationId] = useState<string | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [draft, setDraft] = useState({
    title: "",
    description: "",
    projectId: "",
    assigneeAgentId: "",
    priority: "medium",
    concurrencyPolicy: "coalesce_if_active",
    catchUpPolicy: "skip_missed",
  });

  useEffect(() => {
    setBreadcrumbs([{ label: "Automations" }]);
  }, [setBreadcrumbs]);

  useEffect(() => {
    if (!selectedOrganizationId) {
      setHeaderActions(null);
      return;
    }

    setHeaderActions(
      <Button type="button" size="sm" className="px-4" onClick={() => setComposerOpen(true)}>
        <Plus className="mr-1.5 h-3.5 w-3.5" />
        Create automation
      </Button>,
    );

    return () => setHeaderActions(null);
  }, [selectedOrganizationId, setHeaderActions]);

  const { data: automations, isLoading, error } = useQuery({
    queryKey: queryKeys.automations.list(selectedOrganizationId!),
    queryFn: () => automationsApi.list(selectedOrganizationId!),
    enabled: !!selectedOrganizationId,
  });
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedOrganizationId!),
    queryFn: () => agentsApi.list(selectedOrganizationId!),
    enabled: !!selectedOrganizationId,
  });
  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedOrganizationId!),
    queryFn: () => projectsApi.list(selectedOrganizationId!),
    enabled: !!selectedOrganizationId,
  });

  useEffect(() => {
    autoResizeTextarea(titleInputRef.current);
  }, [draft.title, composerOpen]);

  const createAutomation = useMutation({
    mutationFn: () =>
      automationsApi.create(selectedOrganizationId!, {
        ...draft,
        description: draft.description.trim() || null,
      }),
    onSuccess: async (automation) => {
      setDraft({
        title: "",
        description: "",
        projectId: "",
        assigneeAgentId: "",
        priority: "medium",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      });
      setComposerOpen(false);
      setAdvancedOpen(false);
      await queryClient.invalidateQueries({ queryKey: queryKeys.automations.list(selectedOrganizationId!) });
      pushToast({
        title: "Automation created",
        body: "Add the first trigger to turn it into a live workflow.",
        tone: "success",
      });
      navigate(`/automations/${automation.id}?tab=triggers`);
    },
  });

  const updateAutomationStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => automationsApi.update(id, { status }),
    onMutate: ({ id }) => {
      setStatusMutationAutomationId(id);
    },
    onSuccess: async (_, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.automations.list(selectedOrganizationId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.automations.detail(variables.id) }),
      ]);
    },
    onSettled: () => {
      setStatusMutationAutomationId(null);
    },
    onError: (mutationError) => {
      pushToast({
        title: "Failed to update automation",
        body: mutationError instanceof Error ? mutationError.message : "Rudder could not update the automation.",
        tone: "error",
      });
    },
  });

  const runAutomation = useMutation({
    mutationFn: (id: string) => automationsApi.run(id),
    onMutate: (id) => {
      setRunningAutomationId(id);
    },
    onSuccess: async (_, id) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.automations.list(selectedOrganizationId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.automations.detail(id) }),
      ]);
    },
    onSettled: () => {
      setRunningAutomationId(null);
    },
    onError: (mutationError) => {
      pushToast({
        title: "Automation run failed",
        body: mutationError instanceof Error ? mutationError.message : "Rudder could not start the automation run.",
        tone: "error",
      });
    },
  });

  const recentAssigneeIds = useMemo(() => getRecentAssigneeIds(), [composerOpen]);
  const assigneeOptions = useMemo<InlineEntityOption[]>(
    () =>
      sortAgentsByRecency(
        (agents ?? []).filter((agent) => agent.status !== "terminated"),
        recentAssigneeIds,
      ).map((agent) => ({
        id: agent.id,
        label: formatChatAgentLabel(agent),
        searchText: `${agent.name} ${agent.role} ${agent.title ?? ""}`,
      })),
    [agents, recentAssigneeIds],
  );
  const projectOptions = useMemo<InlineEntityOption[]>(
    () =>
      (projects ?? []).map((project) => ({
        id: project.id,
        label: project.name,
        searchText: project.description ?? "",
      })),
    [projects],
  );
  const agentById = useMemo(
    () => new Map((agents ?? []).map((agent) => [agent.id, agent])),
    [agents],
  );
  const projectById = useMemo(
    () => new Map((projects ?? []).map((project) => [project.id, project])),
    [projects],
  );
  const currentAssignee = draft.assigneeAgentId ? agentById.get(draft.assigneeAgentId) ?? null : null;
  const currentProject = draft.projectId ? projectById.get(draft.projectId) ?? null : null;
  const isDraftReady = Boolean(draft.title.trim() && draft.projectId && draft.assigneeAgentId);

  if (!selectedOrganizationId) {
    return <EmptyState icon={Repeat} message="Select an organization to view automations." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="issues-list" />;
  }

  return (
    <div className="space-y-6">
      <Dialog
        open={composerOpen}
        onOpenChange={(open) => {
          if (!createAutomation.isPending) {
            setComposerOpen(open);
          }
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="max-h-[78vh] gap-0 overflow-hidden rounded-2xl border-border/70 p-0 shadow-[0_24px_80px_rgba(0,0,0,0.12)] sm:max-w-[min(980px,calc(100vw-2.5rem))]"
        >
          <div className="border-b border-border/60 px-6 py-4">
            <div className="flex items-start justify-between gap-4">
              <textarea
                ref={titleInputRef}
                className="min-h-[34px] w-full resize-none overflow-hidden bg-transparent text-[1.2rem] leading-tight font-medium tracking-tight outline-none placeholder:text-muted-foreground/60"
                placeholder="Automation title"
                rows={1}
                value={draft.title}
                onChange={(event) => {
                  setDraft((current) => ({ ...current, title: event.target.value }));
                  autoResizeTextarea(event.target);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.metaKey && !event.ctrlKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    descriptionEditorRef.current?.focus();
                    return;
                  }
                  if (event.key === "Tab" && !event.shiftKey) {
                    event.preventDefault();
                    descriptionEditorRef.current?.focus();
                  }
                }}
                autoFocus
              />

              <div className="flex items-center gap-2 pt-0.5">
                <TooltipProvider delayDuration={120}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-border/80 bg-background text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
                        aria-label="Automation help"
                      >
                        <CircleHelp className="h-3.5 w-3.5" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" sideOffset={8} className="max-w-[320px] px-3 py-2 text-xs leading-5">
                      Define the recurring work first. Trigger setup comes next on the detail page.
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
            </div>
          </div>

          <div className="min-h-0 overflow-y-auto px-6 pt-4">
            <MarkdownEditor
              ref={descriptionEditorRef}
              value={draft.description}
              onChange={(description) => setDraft((current) => ({ ...current, description }))}
              placeholder="Add prompt e.g. look for crashes in Sentry"
              bordered={false}
              className="bg-transparent"
              contentClassName="min-h-[300px] text-[15px] leading-6 text-foreground/90 md:min-h-[340px]"
              onSubmit={() => {
                if (!createAutomation.isPending && isDraftReady) {
                  createAutomation.mutate();
                }
              }}
            />
          </div>

          <div className="flex flex-col gap-3 border-t border-border/60 px-6 py-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
              <div className="inline-flex min-w-0 items-center gap-1.5 rounded-full border border-border/80 px-2.5 py-1.5">
                <User className="h-3.5 w-3.5 text-muted-foreground" />
                <InlineEntitySelector
                  ref={assigneeSelectorRef}
                  value={draft.assigneeAgentId}
                  options={assigneeOptions}
                  placeholder="Assignee"
                  noneLabel="No assignee"
                  searchPlaceholder="Search assignees..."
                  emptyMessage="No assignees found."
                  className="border-0 bg-transparent p-0 text-xs font-normal shadow-none hover:bg-transparent"
                  onChange={(assigneeAgentId) => {
                    if (assigneeAgentId) trackRecentAssignee(assigneeAgentId);
                    setDraft((current) => ({ ...current, assigneeAgentId }));
                  }}
                  onConfirm={() => projectSelectorRef.current?.focus()}
                  renderTriggerValue={(option) =>
                    option ? (
                      currentAssignee ? (
                        <>
                          <AgentIcon icon={currentAssignee.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          <span className="truncate">{option.label}</span>
                        </>
                      ) : (
                        <span className="truncate">{option.label}</span>
                      )
                    ) : (
                      <span className="text-muted-foreground">Assignee</span>
                    )
                  }
                  renderOption={(option) => {
                    if (!option.id) return <span className="truncate">{option.label}</span>;
                    const assignee = agentById.get(option.id);
                    return (
                      <>
                        {assignee ? <AgentIcon icon={assignee.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : null}
                        <span className="truncate">{option.label}</span>
                      </>
                    );
                  }}
                />
              </div>

              <div className="inline-flex min-w-0 items-center gap-1.5 rounded-full border border-border/80 px-2.5 py-1.5">
                <FolderOpen className="h-3.5 w-3.5 text-muted-foreground" />
                <InlineEntitySelector
                  ref={projectSelectorRef}
                  value={draft.projectId}
                  options={projectOptions}
                  placeholder="Project"
                  noneLabel="No project"
                  searchPlaceholder="Search projects..."
                  emptyMessage="No projects found."
                  className="border-0 bg-transparent p-0 text-xs font-normal shadow-none hover:bg-transparent"
                  onChange={(projectId) => setDraft((current) => ({ ...current, projectId }))}
                  onConfirm={() => descriptionEditorRef.current?.focus()}
                  renderTriggerValue={(option) =>
                    option && currentProject ? (
                      <>
                        <span
                          className="h-3.5 w-3.5 shrink-0 rounded-sm"
                          style={projectColorBackgroundStyle(currentProject.color)}
                        />
                        <span className="truncate">{option.label}</span>
                      </>
                    ) : (
                      <span className="text-muted-foreground">Project</span>
                    )
                  }
                  renderOption={(option) => {
                    if (!option.id) return <span className="truncate">{option.label}</span>;
                    const project = projectById.get(option.id);
                    return (
                      <>
                        <span
                          className="h-3.5 w-3.5 shrink-0 rounded-sm"
                          style={projectColorBackgroundStyle(project?.color)}
                        />
                        <span className="truncate">{option.label}</span>
                      </>
                    );
                  }}
                />
              </div>

              <Popover open={advancedOpen} onOpenChange={setAdvancedOpen}>
                <PopoverTrigger asChild>
                  <Button variant="ghost" size="icon-xs" type="button" className="rounded-full border border-transparent">
                    <MoreHorizontal className="h-3.5 w-3.5" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" side="top" sideOffset={10} className="w-[320px] space-y-4 p-4">
                  <div className="space-y-2">
                    <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Concurrency</p>
                    <Select
                      value={draft.concurrencyPolicy}
                      onValueChange={(concurrencyPolicy) => setDraft((current) => ({ ...current, concurrencyPolicy }))}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {concurrencyPolicies.map((value) => (
                          <SelectItem key={value} value={value}>{value.replaceAll("_", " ")}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs leading-5 text-muted-foreground">{concurrencyPolicyDescriptions[draft.concurrencyPolicy]}</p>
                  </div>

                  <div className="space-y-2">
                    <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Catch-up</p>
                    <Select
                      value={draft.catchUpPolicy}
                      onValueChange={(catchUpPolicy) => setDraft((current) => ({ ...current, catchUpPolicy }))}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {catchUpPolicies.map((value) => (
                          <SelectItem key={value} value={value}>{value.replaceAll("_", " ")}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs leading-5 text-muted-foreground">{catchUpPolicyDescriptions[draft.catchUpPolicy]}</p>
                  </div>
                </PopoverContent>
              </Popover>
            </div>

            <div className="flex items-center justify-end gap-3">
              <Button
                variant="ghost"
                size="sm"
                type="button"
                onClick={() => {
                  setComposerOpen(false);
                  setAdvancedOpen(false);
                }}
                disabled={createAutomation.isPending}
              >
                Cancel
              </Button>
              <div className="flex flex-col items-end gap-2">
                <Button size="sm" onClick={() => createAutomation.mutate()} disabled={createAutomation.isPending || !isDraftReady}>
                  {createAutomation.isPending ? "Creating..." : "Create"}
                  <ArrowRight className="ml-1 h-3.5 w-3.5" />
                </Button>
                {createAutomation.isError ? (
                  <p className="text-sm text-destructive">
                    {createAutomation.error instanceof Error ? createAutomation.error.message : "Failed to create automation"}
                  </p>
                ) : null}
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {error ? (
        <Card>
          <CardContent className="pt-6 text-sm text-destructive">
            {error instanceof Error ? error.message : "Failed to load automations"}
          </CardContent>
        </Card>
      ) : null}

      <div>
        {(automations ?? []).length === 0 ? (
          <div className="py-12">
            <EmptyState
              icon={Repeat}
              message="No automations yet. Use Create automation to define the first recurring workflow."
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b border-border">
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">Project</th>
                  <th className="px-3 py-2 font-medium">Agent</th>
                  <th className="px-3 py-2 font-medium">Last run</th>
                  <th className="px-3 py-2 font-medium">Enabled</th>
                  <th className="w-12 px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {(automations ?? []).map((automation) => {
                  const enabled = automation.status === "active";
                  const isArchived = automation.status === "archived";
                  const isStatusPending = statusMutationAutomationId === automation.id;
                  return (
                    <tr
                      key={automation.id}
                      className="align-middle border-b border-border transition-colors hover:bg-accent/50 last:border-b-0 cursor-pointer"
                      onClick={() => navigate(`/automations/${automation.id}`)}
                    >
                      <td className="px-3 py-2.5">
                        <div className="min-w-[180px]">
                          <span className="font-medium">
                            {automation.title}
                          </span>
                          {(isArchived || automation.status === "paused") && (
                            <div className="mt-1 text-xs text-muted-foreground">
                              {isArchived ? "archived" : "paused"}
                            </div>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        {automation.projectId ? (
                          <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            <span
                              className="shrink-0 h-3 w-3 rounded-sm"
                              style={projectColorBackgroundStyle(projectById.get(automation.projectId)?.color)}
                            />
                            <span className="truncate">{projectById.get(automation.projectId)?.name ?? "Unknown"}</span>
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        {automation.assigneeAgentId ? (() => {
                          const agent = agentById.get(automation.assigneeAgentId);
                          return agent ? (
                            <div className="flex items-center gap-2 text-sm text-muted-foreground">
                              <AgentIcon icon={agent.icon} className="h-4 w-4 shrink-0" />
                              <span className="truncate">{formatChatAgentLabel(agent)}</span>
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">Unknown</span>
                          );
                        })() : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-muted-foreground">
                        <div>{formatLastRunTimestamp(automation.lastRun?.triggeredAt)}</div>
                        {automation.lastRun ? (
                          <div className="mt-1 text-xs">{automation.lastRun.status.replaceAll("_", " ")}</div>
                        ) : null}
                      </td>
                      <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center gap-3">
                          <ToggleSwitch
                            checked={enabled}
                            size="md"
                            tone="success"
                            aria-label={enabled ? `Disable ${automation.title}` : `Enable ${automation.title}`}
                            disabled={isStatusPending || isArchived}
                            onClick={() =>
                              updateAutomationStatus.mutate({
                                id: automation.id,
                                status: nextAutomationStatus(automation.status, !enabled),
                              })
                            }
                          />
                          <span className="text-xs text-muted-foreground">
                            {isArchived ? "Archived" : enabled ? "On" : "Off"}
                          </span>
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-right" onClick={(e) => e.stopPropagation()}>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon-sm" aria-label={`More actions for ${automation.title}`}>
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => navigate(`/automations/${automation.id}`)}>
                              Edit
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              disabled={runningAutomationId === automation.id || isArchived}
                              onClick={() => runAutomation.mutate(automation.id)}
                            >
                              {runningAutomationId === automation.id ? "Running..." : "Run now"}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={() =>
                                updateAutomationStatus.mutate({
                                  id: automation.id,
                                  status: enabled ? "paused" : "active",
                                })
                              }
                              disabled={isStatusPending || isArchived}
                            >
                              {enabled ? "Pause" : "Enable"}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() =>
                                updateAutomationStatus.mutate({
                                  id: automation.id,
                                  status: automation.status === "archived" ? "active" : "archived",
                                })
                              }
                              disabled={isStatusPending}
                            >
                              {automation.status === "archived" ? "Restore" : "Archive"}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
