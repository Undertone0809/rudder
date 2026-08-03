import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { useNavigate, useParams } from "@/lib/router";
import type { InstanceLocale, IssueAssigneeAgentRuntimeOverrides } from "@rudderhq/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Bot,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  FolderOpen,
  LayoutTemplate,
  MessageSquare,
  MoreHorizontal,
  PanelRight,
  Pause,
  Pencil,
  Play,
  Plus,
  Repeat,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { agentsApi } from "../api/agents";
import { automationsApi } from "../api/automations";
import { issuesApi } from "../api/issues";
import { organizationSkillsApi } from "../api/organizationSkills";
import { projectsApi } from "../api/projects";
import { AgentIcon } from "../components/AgentIconPicker";
import { EmptyState } from "../components/EmptyState";
import { InlineEntitySelector, type InlineEntityOption } from "../components/InlineEntitySelector";
import { IssueRuntimeSelector } from "../components/IssueRuntimeSelector";
import { MarkdownEditor, type MarkdownEditorRef } from "../components/MarkdownEditor";
import { PageSkeleton } from "../components/PageSkeleton";
import { ProjectIcon } from "../components/ProjectIdentity";
import { ScheduleEditor, describeSchedule } from "../components/ScheduleEditor";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useDialog } from "../context/DialogContext";
import { useI18n } from "../context/I18nContext";
import { useOrganization } from "../context/OrganizationContext";
import { useToast } from "../context/ToastContext";
import { useScrollbarActivityRef } from "../hooks/useScrollbarActivityRef";
import { formatChatAgentLabel } from "../lib/agent-labels";
import { buildAgentSkillMentionOptions } from "../lib/agent-skill-mentions";
import {
  automationPolicyDescription,
  automationPolicyLabel,
  catchUpPolicyDescriptions,
  concurrencyPolicyDescriptions,
} from "../lib/automation-localization";
import { getAutomationRunDisplay } from "../lib/automation-run-display";
import { markdownDocumentOrNull } from "../lib/markdown-document-value";
import { buildMarkdownMentionOptions } from "../lib/markdown-mention-options";
import { queryKeys } from "../lib/queryKeys";
import { getRecentAssigneeIds, sortAgentsByRecency, trackRecentAssignee } from "../lib/recent-assignees";
import { cn, formatDateTimeSeconds } from "../lib/utils";
import { AutomationDetail } from "./AutomationDetail";

const concurrencyPolicies = ["coalesce_if_active", "always_enqueue", "skip_if_active"];
const catchUpPolicies = ["skip_missed", "enqueue_missed_with_cap"];
const automationComposerChipClass =
  "h-8 items-center rounded-md px-2.5 text-xs font-medium leading-none";
const automationComposerChipIconClass =
  "h-3.5 w-3.5 shrink-0 text-muted-foreground";

type AutomationOutputMode = "track_issue" | "chat_output";
type AutomationStatusFilter = "all" | "active" | "paused";

type LocalizedText = {
  en: string;
  "zh-CN": string;
};

type AutomationTemplate = {
  id: string;
  title: LocalizedText;
  summary: LocalizedText;
  description: LocalizedText;
  scheduleCron: string;
  outputMode: AutomationOutputMode;
};

const automationTemplates: AutomationTemplate[] = [
  {
    id: "daily-review",
    title: { en: "Daily review", "zh-CN": "每日回顾" },
    summary: { en: "Review today's work and draft a short status update.", "zh-CN": "回顾今天的工作并生成简短状态更新。" },
    scheduleCron: "0 18 * * *",
    outputMode: "chat_output",
    description: {
      en: [
        "Review what I worked on today and draft a short status update.",
        "",
        "Scope: Review today's issues, comments, chats, and runs, including work completed since the previous review.",
        "",
        "Status: Summarize what was completed, what is still in progress, and what remains unfinished or blocked.",
        "",
        "Decisions: Note important decisions, changes in direction, and anything that needs my review.",
        "",
        "Next: Recommend the highest-priority next action for tomorrow.",
        "",
        "Keep the update concise and evidence-based. Only create tracked work for a concrete blocker or follow-up action.",
      ].join("\n"),
      "zh-CN": [
        "回顾我今天完成的工作，并生成一份简短的状态更新。",
        "",
        "范围：查看今天的任务、评论、聊天和运行记录，包括上次回顾后完成的工作。",
        "",
        "状态：汇总已完成、进行中、尚未完成或被阻塞的内容。",
        "",
        "决策：记录重要决策、方向变化，以及需要我 review 的事项。",
        "",
        "下一步：推荐明天优先级最高的行动。",
        "",
        "保持简洁并以实际证据为准。只有出现明确阻塞或后续行动时才创建可跟踪任务。",
      ].join("\n"),
    },
  },
  {
    id: "bug-triage",
    title: { en: "Bug triage", "zh-CN": "Bug 分诊" },
    summary: { en: "Assess and prioritize new bug reports.", "zh-CN": "评估并排序新提交的缺陷。" },
    scheduleCron: "0 9 * * 1-5",
    outputMode: "track_issue",
    description: {
      en: [
        "1. List all open issues labeled bug, triage, or backlog that have not been prioritized.",
        "2. Read the issue description, attached screenshots, logs, and latest comments.",
        "3. Assess severity as critical, high, medium, or low based on user impact and scope.",
        "4. Update priority where the evidence is clear, or leave a comment with the recommended priority.",
        "5. Summarize what changed and call out anything that needs human review.",
      ].join("\n"),
      "zh-CN": [
        "1. 列出尚未排序的 bug、triage 或 backlog 任务。",
        "2. 阅读任务描述、截图、日志和最新评论。",
        "3. 按用户影响和范围评估严重度：紧急、高、中、低。",
        "4. 证据明确时更新优先级；不明确时留下推荐优先级和理由。",
        "5. 汇总本轮变更，并标出需要人工确认的内容。",
      ].join("\n"),
    },
  },
  {
    id: "pr-review-reminder",
    title: { en: "PR review reminder", "zh-CN": "PR review 提醒" },
    summary: { en: "Flag stale pull requests that need review.", "zh-CN": "找出等待 review 过久的 PR。" },
    scheduleCron: "0 10 * * 1-5",
    outputMode: "track_issue",
    description: {
      en: [
        "1. Find pull requests waiting for review for more than one business day.",
        "2. Check whether each PR is blocked, failing CI, or missing a clear reviewer.",
        "3. Comment on the related issue or PR with the specific next action.",
        "4. Escalate only PRs that affect active milestone work.",
      ].join("\n"),
      "zh-CN": [
        "1. 找出等待 review 超过一个工作日的 PR。",
        "2. 检查每个 PR 是否被阻塞、CI 失败或缺少明确 reviewer。",
        "3. 在相关任务或 PR 中评论具体下一步。",
        "4. 只升级影响当前里程碑工作的 PR。",
      ].join("\n"),
    },
  },
  {
    id: "weekly-progress-report",
    title: { en: "Weekly progress report", "zh-CN": "周进展报告" },
    summary: { en: "Compile a concise summary of team progress.", "zh-CN": "整理团队本周进展和风险。" },
    scheduleCron: "0 17 * * 1",
    outputMode: "track_issue",
    description: {
      en: [
        "1. Gather issues completed in the past 7 days.",
        "2. Gather issues currently in progress and identify blocked work.",
        "3. Calculate key movement: closed, opened, reopened, and blocked.",
        "4. Write a structured report with sections for completed, in progress, blocked, and risks.",
        "5. Post the report where the board can review it.",
      ].join("\n"),
      "zh-CN": [
        "1. 汇总过去 7 天完成的任务。",
        "2. 汇总进行中的任务，并识别阻塞项。",
        "3. 统计关键变化：关闭、新增、重开、阻塞。",
        "4. 输出结构化报告：已完成、进行中、阻塞、风险。",
        "5. 把报告发布到 board 方便 review。",
      ].join("\n"),
    },
  },
  {
    id: "documentation-check",
    title: { en: "Documentation check", "zh-CN": "文档检查" },
    summary: { en: "Review recent changes for documentation gaps.", "zh-CN": "检查近期变更对应的文档缺口。" },
    scheduleCron: "0 14 * * 3",
    outputMode: "track_issue",
    description: {
      en: [
        "1. Review merged product or engineering changes from the past week.",
        "2. Identify user-facing docs, contributor docs, or runbooks that are stale or missing.",
        "3. Rank gaps by user impact and likelihood of repeated confusion.",
        "4. Draft precise documentation tasks with file paths and acceptance criteria.",
      ].join("\n"),
      "zh-CN": [
        "1. 回顾过去一周合入的产品或工程变更。",
        "2. 找出过期或缺失的用户文档、贡献者文档、runbook。",
        "3. 按用户影响和重复困惑概率排序缺口。",
        "4. 起草带文件路径和验收标准的文档任务。",
      ].join("\n"),
    },
  },
  {
    id: "daily-news-digest",
    title: { en: "Daily news digest", "zh-CN": "每日信息简报" },
    summary: { en: "Search and summarize relevant updates for the team.", "zh-CN": "检索并总结团队需要知道的外部变化。" },
    scheduleCron: "0 8 * * 1-5",
    outputMode: "chat_output",
    description: {
      en: [
        "1. Search for important market, customer, or platform updates relevant to the organization.",
        "2. Filter out duplicate, speculative, or low-signal items.",
        "3. Summarize each retained item in one paragraph with source and implication.",
        "4. Call out whether any item should become tracked work.",
      ].join("\n"),
      "zh-CN": [
        "1. 搜索和组织相关的市场、客户或平台重要更新。",
        "2. 过滤重复、猜测性或低信号内容。",
        "3. 每条保留信息用一段话总结来源和影响。",
        "4. 标出哪些信息值得转成可跟踪任务。",
      ].join("\n"),
    },
  },
  {
    id: "daily-standup",
    title: { en: "Daily standup review", "zh-CN": "日会" },
    summary: { en: "Summarize daily agent work, risks, and next actions for review.", "zh-CN": "汇总今天的阻塞、重点和交接事项。" },
    scheduleCron: "30 9 * * 1-5",
    outputMode: "chat_output",
    description: {
      en: [
        "For each active agent or owner:",
        "",
        "1. Review today's work across issues, comments, chats, and runs since the previous workday.",
        "2. Summarize what was completed, what is still in progress, what remains unfinished, and what has not started yet.",
        "3. Reflect on the current direction, identify blockers or risks, and call out anything that needs my review.",
        "4. Propose the next concrete tasks or decisions for me to review.",
        "",
        "Keep the summary concise and useful for a daily standup.",
        "",
        "Format the result by owner or agent with: Completed, In progress, Unfinished or not started, Blockers or risks, Recommended next tasks, and Needs my review.",
        "Only create or update tracked work when there is a concrete blocker, follow-up task, or review item.",
      ].join("\n"),
      "zh-CN": [
        "1. 查看上一个工作日以来更新的进行中任务、最新评论和运行记录。",
        "2. 汇总每个活跃 owner 已完成、下一步计划和阻塞项。",
        "3. 输出保持日会可读的长度。",
        "4. 只有明确阻塞才创建或更新可跟踪任务。",
      ].join("\n"),
    },
  },
];

const blankAutomationTemplate: AutomationTemplate = {
  id: "custom",
  title: { en: "", "zh-CN": "" },
  summary: { en: "Create a custom recurring workflow.", "zh-CN": "创建自定义循环工作流。" },
  description: {
    en: "",
    "zh-CN": "",
  },
  scheduleCron: "0 9 * * *",
  outputMode: "chat_output",
};

function localizeText(text: LocalizedText, locale: InstanceLocale) {
  return text[locale] ?? text.en;
}

function outputMethodCopy(locale: InstanceLocale) {
  if (locale === "zh-CN") {
    return {
      heading: "运行输出",
      trackIssue: "跟踪为任务",
      trackIssueSummary: "每次运行创建可跟踪任务",
      sendToChat: "发送到聊天",
      sendToChatSummary: "每次运行发布到新聊天",
      newChatPerRun: "每次运行新建聊天",
    };
  }
  return {
    heading: "Run output",
    trackIssue: "Track as issue",
    trackIssueSummary: "Each run opens board-tracked work",
    sendToChat: "Send to chat",
    sendToChatSummary: "Post each run to a new chat",
    newChatPerRun: "New chat per run",
  };
}

function autoResizeTextarea(element: HTMLTextAreaElement | null) {
  if (!element) return;
  element.style.height = "auto";
  element.style.height = `${element.scrollHeight}px`;
}

function formatLastRunTimestamp(value: Date | string | null | undefined) {
  if (!value) return "Never";
  return formatDateTimeSeconds(value);
}

function getLocalTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

function nextAutomationStatus(enabled: boolean) {
  return enabled ? "active" : "paused";
}

export function Automations() {
  const { automationId } = useParams<{ automationId: string }>();
  const { selectedOrganizationId, selectedOrganization } = useOrganization();
  const { setBreadcrumbs, setHeaderActions } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { confirm } = useDialog();
  const { locale } = useI18n();
  const outputCopy = outputMethodCopy(locale);
  const { pushToast } = useToast();
  const descriptionEditorRef = useRef<MarkdownEditorRef>(null);
  const titleInputRef = useRef<HTMLTextAreaElement | null>(null);
  const descriptionComposerRef = useRef<HTMLDivElement | null>(null);
  const assigneeSelectorRef = useRef<HTMLButtonElement | null>(null);
  const projectSelectorRef = useRef<HTMLButtonElement | null>(null);
  const expandDetailButtonRef = useRef<HTMLButtonElement | null>(null);
  const collapseDetailButtonRef = useRef<HTMLButtonElement | null>(null);
  const composerBodyScrollRef = useScrollbarActivityRef("rudder:automation-composer-body");
  const composerMainScrollRef = useScrollbarActivityRef("rudder:automation-composer-main");
  const [runningAutomationId, setRunningAutomationId] = useState<string | null>(null);
  const [statusMutationAutomationId, setStatusMutationAutomationId] = useState<string | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [documentSessionId, setDocumentSessionId] = useState(0);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [detailCollapsed, setDetailCollapsed] = useState(false);
  const [statusFilter, setStatusFilter] = useState<AutomationStatusFilter>("all");
  const [draft, setDraft] = useState<{
    title: string;
    description: string;
    projectId: string;
    assigneeAgentId: string;
    assigneeAgentRuntimeOverrides: IssueAssigneeAgentRuntimeOverrides | null;
    priority: string;
    concurrencyPolicy: string;
    catchUpPolicy: string;
    scheduleCron: string;
    outputMode: AutomationOutputMode;
    chatConversationId: string;
  }>({
    title: "",
    description: "",
    projectId: "",
    assigneeAgentId: "",
    assigneeAgentRuntimeOverrides: null,
    priority: "medium",
    concurrencyPolicy: "coalesce_if_active",
    catchUpPolicy: "skip_missed",
    scheduleCron: "0 9 * * *",
    outputMode: "chat_output" as AutomationOutputMode,
    chatConversationId: "",
  });

  const resetDraft = useCallback(() => {
    setDocumentSessionId((current) => current + 1);
    setDraft({
      title: "",
      description: "",
      projectId: "",
      assigneeAgentId: "",
      assigneeAgentRuntimeOverrides: null,
      priority: "medium",
      concurrencyPolicy: "coalesce_if_active",
      catchUpPolicy: "skip_missed",
      scheduleCron: "0 9 * * *",
      outputMode: "chat_output",
      chatConversationId: "",
    });
  }, []);

  const openComposer = useCallback((template: AutomationTemplate = blankAutomationTemplate) => {
    setDocumentSessionId((current) => current + 1);
    setDraft((current) => ({
      ...current,
      title: localizeText(template.title, locale),
      description: localizeText(template.description, locale),
      scheduleCron: template.scheduleCron,
      outputMode: template.outputMode,
      chatConversationId: "",
    }));
    setTemplatePickerOpen(false);
    setAdvancedOpen(false);
    setComposerOpen(true);
  }, [locale]);

  const selectOutputMode = useCallback((outputMode: AutomationOutputMode) => {
    setDraft((current) => ({
      ...current,
      outputMode,
      chatConversationId: "",
    }));
  }, []);

  useEffect(() => {
    setBreadcrumbs([{ label: "Automations" }]);
  }, [setBreadcrumbs]);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const wideDetailLayout = window.matchMedia("(min-width: 1100px)");
    const resetCollapsedDetailOnNarrowLayout = () => {
      if (!wideDetailLayout.matches) setDetailCollapsed(false);
    };
    resetCollapsedDetailOnNarrowLayout();
    wideDetailLayout.addEventListener("change", resetCollapsedDetailOnNarrowLayout);
    return () => wideDetailLayout.removeEventListener("change", resetCollapsedDetailOnNarrowLayout);
  }, []);

  useEffect(() => {
    if (!selectedOrganizationId) {
      setHeaderActions(null);
      return;
    }

    setHeaderActions(
      <Button type="button" size="sm" className="px-4" onClick={() => openComposer()}>
        <Plus className="mr-1.5 h-3.5 w-3.5" />
        Create automation
      </Button>,
    );

    return () => setHeaderActions(null);
  }, [openComposer, selectedOrganizationId, setHeaderActions]);

  const { data: automations, isLoading, error } = useQuery({
    queryKey: queryKeys.automations.list(selectedOrganizationId!),
    queryFn: () => automationsApi.list(selectedOrganizationId!),
    enabled: !!selectedOrganizationId,
  });
  const filteredAutomations = useMemo(
    () => (automations ?? []).filter((automation) => (
      statusFilter === "all" || automation.status === statusFilter
    )),
    [automations, statusFilter],
  );
  const applyStatusFilter = useCallback((value: AutomationStatusFilter) => {
    setStatusFilter(value);
    if (value === "all" || !automationId) return;
    const selectedAutomation = (automations ?? []).find((automation) => automation.id === automationId);
    if (selectedAutomation && selectedAutomation.status !== value) {
      navigate("/automations");
    }
  }, [automationId, automations, navigate]);
  useEffect(() => {
    if (statusFilter === "all" || !automationId) return;
    const selectedAutomation = (automations ?? []).find((automation) => automation.id === automationId);
    if (selectedAutomation && selectedAutomation.status !== statusFilter) {
      navigate("/automations");
    }
  }, [automationId, automations, navigate, statusFilter]);
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
  const { data: issues } = useQuery({
    queryKey: queryKeys.issues.list(selectedOrganizationId!),
    queryFn: () => issuesApi.list(selectedOrganizationId!),
    enabled: !!selectedOrganizationId && composerOpen,
  });
  const { data: assigneeOrganizationSkills } = useQuery({
    queryKey: queryKeys.organizationSkills.list(selectedOrganizationId ?? "__none__"),
    queryFn: () => organizationSkillsApi.list(selectedOrganizationId!),
    enabled: Boolean(selectedOrganizationId) && composerOpen && Boolean(draft.assigneeAgentId),
  });
  const { data: assigneeSkillSnapshot } = useQuery({
    queryKey: queryKeys.agents.skills(draft.assigneeAgentId || "__none__"),
    queryFn: () => agentsApi.skills(draft.assigneeAgentId, selectedOrganizationId!),
    enabled: Boolean(selectedOrganizationId) && composerOpen && Boolean(draft.assigneeAgentId),
  });

  useEffect(() => {
    autoResizeTextarea(titleInputRef.current);
  }, [draft.title, composerOpen]);

  const createAutomation = useMutation({
    mutationFn: async () => {
      const currentInstructions = descriptionEditorRef.current?.getMarkdown?.() ?? draft.description;
      const automation = await automationsApi.create(selectedOrganizationId!, {
        title: draft.title,
        instructions: markdownDocumentOrNull(currentInstructions),
        projectId: draft.projectId || null,
        assigneeAgentId: draft.assigneeAgentId,
        assigneeAgentRuntimeOverrides: draft.assigneeAgentRuntimeOverrides,
        priority: draft.priority,
        concurrencyPolicy: draft.concurrencyPolicy,
        catchUpPolicy: draft.catchUpPolicy,
        outputMode: draft.outputMode,
        chatConversationId: null,
        notifyOnIssueCreated: false,
      });

      if (draft.scheduleCron.trim()) {
        await automationsApi.createTrigger(automation.id, {
          kind: "schedule",
          cronExpression: draft.scheduleCron.trim(),
          timezone: getLocalTimezone(),
        });
      }

      return automation;
    },
    onSuccess: async (automation) => {
      resetDraft();
      setComposerOpen(false);
      setTemplatePickerOpen(false);
      setAdvancedOpen(false);
      await queryClient.invalidateQueries({ queryKey: queryKeys.automations.list(selectedOrganizationId!) });
      pushToast({
        title: "Automation created",
        body: draft.scheduleCron.trim()
          ? "Schedule trigger is ready. Review the runbook before it goes live."
          : "Add a trigger when you are ready to run it automatically.",
        tone: "success",
      });
      navigate(`/automations/${automation.id}`);
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

  const deleteAutomation = useMutation({
    mutationFn: (id: string) => automationsApi.delete(id),
    onSuccess: async (_, id) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.automations.list(selectedOrganizationId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.automations.detail(id) }),
      ]);
      pushToast({ title: "Automation deleted", tone: "success" });
    },
    onError: (mutationError) => {
      pushToast({
        title: "Failed to delete automation",
        body: mutationError instanceof Error ? mutationError.message : "Rudder could not delete the automation.",
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
  const skillMentionOptions = useMemo(
    () => buildAgentSkillMentionOptions({
      agent: currentAssignee,
      orgUrlKey: selectedOrganization?.urlKey ?? "organization",
      organizationSkills: assigneeOrganizationSkills,
      skillSnapshot: assigneeSkillSnapshot,
    }),
    [assigneeOrganizationSkills, assigneeSkillSnapshot, currentAssignee, selectedOrganization?.urlKey],
  );
  const mentionOptions = useMemo(
    () => buildMarkdownMentionOptions({
      agents,
      projects,
      issues,
      skillMentionOptions,
    }),
    [agents, issues, projects, skillMentionOptions],
  );
  const isDraftReady = Boolean(draft.title.trim() && draft.assigneeAgentId);

  if (!selectedOrganizationId) {
    return <EmptyState icon={Repeat} message="Select an organization to view automations." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="issues-list" />;
  }

  return (
    <div data-testid="automations-page-content" className="h-full min-h-0 w-full">
      <Dialog
        open={composerOpen}
        onOpenChange={(open) => {
          if (!createAutomation.isPending) {
            setComposerOpen(open);
            if (!open) setTemplatePickerOpen(false);
          }
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="h-[calc(100dvh-1.5rem)] gap-0 overflow-hidden rounded-lg border-border/70 p-0 shadow-[0_18px_60px_rgba(0,0,0,0.16)] sm:max-w-[min(1160px,calc(100vw-2rem))] md:h-[min(720px,calc(100dvh-3rem))]"
        >
          <div className="flex h-full min-h-0 flex-col" data-testid="automation-composer-shell">
            <DialogTitle className="sr-only">New automation</DialogTitle>
            <DialogDescription className="sr-only">
              Create a recurring automation by writing a runbook and choosing an agent and schedule.
            </DialogDescription>
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border/60 px-4 py-3 sm:px-5">
              <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
                {selectedOrganization?.name ? (
                  <>
                    <span className="rounded-sm bg-muted px-1.5 py-0.5 text-xs font-medium text-foreground">
                      {selectedOrganization.name}
                    </span>
                    <span className="text-muted-foreground/60">&rsaquo;</span>
                  </>
                ) : null}
                <span className="font-medium text-foreground">New automation</span>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Popover open={templatePickerOpen} onOpenChange={setTemplatePickerOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      type="button"
                      className="h-8 px-2.5 text-xs"
                    >
                      <LayoutTemplate className="mr-1.5 h-3.5 w-3.5" />
                      {locale === "zh-CN" ? "使用模板" : "Use template"}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent
                    align="end"
                    sideOffset={8}
                    data-testid="automation-template-picker"
                    className="max-h-[min(560px,calc(100dvh-6rem))] w-[min(520px,calc(100vw-2rem))] overflow-y-auto p-2"
                  >
                    <p className="px-2 pb-1.5 pt-1 text-xs font-medium text-muted-foreground">
                      {locale === "zh-CN" ? "模板" : "Templates"}
                    </p>
                    <div className="space-y-0.5">
                      {automationTemplates.map((template) => {
                        const title = localizeText(template.title, locale);
                        const summary = localizeText(template.summary, locale);
                        return (
                          <button
                            key={template.id}
                            type="button"
                            className="flex w-full min-w-0 items-start gap-2.5 rounded-md px-2 py-2.5 text-left transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            onClick={() => openComposer(template)}
                          >
                            <LayoutTemplate className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                            <span className="min-w-0">
                              <span className="block text-sm font-medium text-foreground">{title}</span>
                              <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">{summary}</span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </PopoverContent>
                </Popover>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  type="button"
                  className="shrink-0 text-muted-foreground"
                  onClick={() => {
                    setComposerOpen(false);
                    setTemplatePickerOpen(false);
                    setAdvancedOpen(false);
                  }}
                  disabled={createAutomation.isPending}
                  aria-label="Close automation composer"
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>

            <div
              ref={composerBodyScrollRef}
              className="scrollbar-auto-hide min-h-0 flex-1 overflow-y-auto"
            >
              <main ref={composerMainScrollRef} className="min-w-0 space-y-4 px-4 py-5 sm:px-5">
                <textarea
                  ref={titleInputRef}
                  className="min-h-[38px] w-full resize-none overflow-hidden bg-transparent text-xl font-semibold leading-snug outline-none placeholder:text-muted-foreground/55 sm:text-2xl"
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

                <div ref={descriptionComposerRef} data-testid="automation-instructions-composer">
                  <MarkdownEditor
                    ref={descriptionEditorRef}
                    engine="codemirror"
                    documentIdentity={`new-automation:${documentSessionId}`}
                    value={draft.description}
                    onChange={(description) => setDraft((current) => ({ ...current, description }))}
                    mentions={mentionOptions}
                    mentionMenuAnchorRef={descriptionComposerRef}
                    mentionMenuPlacement="container"
                    placeholder="Add instructions e.g. look for crashes in Sentry"
                    bordered={false}
                    contentClassName="min-h-[320px] bg-transparent text-[15px] leading-7 text-foreground/90 placeholder:text-muted-foreground/55 md:min-h-[440px]"
                    onSubmit={() => {
                      if (!createAutomation.isPending && isDraftReady) {
                        createAutomation.mutate();
                      }
                    }}
                  />
                </div>
              </main>
            </div>

            <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-border/60 px-4 py-2 sm:px-5">
              <InlineEntitySelector
                ref={assigneeSelectorRef}
                value={draft.assigneeAgentId}
                options={assigneeOptions}
                placeholder="Select assignee"
                noneLabel="No assignee"
                searchPlaceholder="Search assignees..."
                emptyMessage="No assignees found."
                className={cn(automationComposerChipClass, "max-w-[210px] bg-transparent")}
                disablePortal
                side="top"
                sideOffset={8}
                onChange={(assigneeAgentId) => {
                  if (assigneeAgentId) trackRecentAssignee(assigneeAgentId);
                  setDraft((current) => ({
                    ...current,
                    assigneeAgentId,
                    assigneeAgentRuntimeOverrides: assigneeAgentId === current.assigneeAgentId
                      ? current.assigneeAgentRuntimeOverrides
                      : null,
                  }));
                }}
                onConfirm={() => projectSelectorRef.current?.focus()}
                renderTriggerValue={(option) =>
                  option ? (
                    currentAssignee ? (
                      <>
                        <AgentIcon icon={currentAssignee.icon} role={currentAssignee.role} className={automationComposerChipIconClass} />
                        <span className="truncate">{option.label}</span>
                      </>
                    ) : (
                      <span className="truncate">{option.label}</span>
                    )
                  ) : (
                    <>
                      <Bot className={automationComposerChipIconClass} />
                      <span className="truncate text-muted-foreground">Assignee</span>
                    </>
                  )
                }
                renderOption={(option) => {
                  if (!option.id) return <span className="truncate">{option.label}</span>;
                  const assignee = agentById.get(option.id);
                  return (
                    <>
                      {assignee ? <AgentIcon icon={assignee.icon} role={assignee.role} className={automationComposerChipIconClass} /> : null}
                      <span className="truncate">{option.label}</span>
                    </>
                  );
                }}
              />

              {currentAssignee && selectedOrganizationId ? (
                <IssueRuntimeSelector
                  agent={currentAssignee}
                  orgId={selectedOrganizationId}
                  overrides={draft.assigneeAgentRuntimeOverrides}
                  variant="menu"
                  onApply={(assigneeAgentRuntimeOverrides) => {
                    setDraft((current) => ({ ...current, assigneeAgentRuntimeOverrides }));
                  }}
                />
              ) : null}

              <InlineEntitySelector
                ref={projectSelectorRef}
                value={draft.projectId}
                options={projectOptions}
                placeholder="No project"
                noneLabel="No project"
                searchPlaceholder="Search projects..."
                emptyMessage="No projects found."
                className={cn(automationComposerChipClass, "max-w-[210px] bg-transparent")}
                disablePortal
                side="top"
                sideOffset={8}
                onChange={(projectId) => setDraft((current) => ({ ...current, projectId }))}
                onConfirm={() => descriptionEditorRef.current?.focus()}
                renderTriggerValue={(option) =>
                  option && currentProject ? (
                    <>
                      <ProjectIcon color={currentProject.color} icon={currentProject.icon} size="xs" />
                      <span className="truncate">{option.label}</span>
                    </>
                  ) : (
                    <>
                      <FolderOpen className={automationComposerChipIconClass} />
                      <span className="truncate text-muted-foreground">No project</span>
                    </>
                  )
                }
                renderOption={(option) => {
                  if (!option.id) return <span className="truncate">{option.label}</span>;
                  const project = projectById.get(option.id);
                  return (
                    <>
                      <ProjectIcon color={project?.color} icon={project?.icon} size="xs" />
                      <span className="truncate">{option.label}</span>
                    </>
                  );
                }}
              />

              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className={cn(
                      "inline-flex max-w-full items-center gap-1.5 border border-border bg-transparent text-foreground transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      automationComposerChipClass,
                    )}
                  >
                    <CalendarClock className={automationComposerChipIconClass} />
                    <span className="truncate">{draft.scheduleCron.trim() ? describeSchedule(draft.scheduleCron, locale) : (locale === "zh-CN" ? "未设置日程" : "No schedule set")}</span>
                    <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground/80" />
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" side="top" sideOffset={8} disablePortal className="w-[min(340px,calc(100vw-2rem))] space-y-3 p-3">
                  <p className="text-xs font-medium text-muted-foreground">Schedule</p>
                  <ScheduleEditor
                    value={draft.scheduleCron}
                    onChange={(scheduleCron) => setDraft((current) => ({ ...current, scheduleCron }))}
                  />
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <CalendarClock className="h-3.5 w-3.5" />
                    {draft.scheduleCron.trim() ? describeSchedule(draft.scheduleCron, locale) : (locale === "zh-CN" ? "未设置日程" : "No schedule set")}
                  </p>
                </PopoverContent>
              </Popover>

              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    data-testid="automation-create-output-mode"
                    className={cn(
                      "inline-flex max-w-full items-center gap-1.5 border border-border bg-transparent text-foreground transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      automationComposerChipClass,
                    )}
                  >
                    {draft.outputMode === "track_issue" ? (
                      <CheckCircle2 className={automationComposerChipIconClass} />
                    ) : (
                      <MessageSquare className={automationComposerChipIconClass} />
                    )}
                    <span className="truncate">{draft.outputMode === "track_issue" ? outputCopy.trackIssue : outputCopy.sendToChat}</span>
                    <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground/80" />
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" side="top" sideOffset={8} disablePortal className="w-[min(320px,calc(100vw-2rem))] space-y-2 p-2">
                  <p className="px-1 pt-1 text-xs font-medium text-muted-foreground">{outputCopy.heading}</p>
                  {([
                    {
                      value: "track_issue" as const,
                      icon: CheckCircle2,
                      title: outputCopy.trackIssue,
                      summary: outputCopy.trackIssueSummary,
                    },
                    {
                      value: "chat_output" as const,
                      icon: MessageSquare,
                      title: outputCopy.sendToChat,
                      summary: outputCopy.sendToChatSummary,
                    },
                  ]).map((option) => {
                    const Icon = option.icon;
                    const selected = draft.outputMode === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        aria-pressed={selected}
                        className={cn(
                          "flex w-full min-w-0 items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors",
                          selected
                            ? "border-foreground/70 bg-accent/60 text-foreground"
                            : "border-border/70 bg-background/40 text-muted-foreground hover:bg-accent/40",
                        )}
                        onClick={() => selectOutputMode(option.value)}
                      >
                        <Icon className="h-4 w-4 shrink-0" />
                        <span className="min-w-0">
                          <span className="block text-sm font-medium">{option.title}</span>
                          <span className="block truncate text-xs text-muted-foreground">{option.summary}</span>
                        </span>
                      </button>
                    );
                  })}
                </PopoverContent>
              </Popover>

              {draft.outputMode === "chat_output" ? (
                <div
                  data-testid="automation-create-chat-destination"
                  className={cn(
                    "inline-flex items-center gap-1.5 border border-border bg-transparent text-muted-foreground",
                    automationComposerChipClass,
                  )}
                >
                  <MessageSquare className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{outputCopy.newChatPerRun}</span>
                </div>
              ) : null}

              <Popover open={advancedOpen} onOpenChange={setAdvancedOpen}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className={cn(
                      "inline-flex items-center gap-1.5 border border-border bg-transparent text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      automationComposerChipClass,
                    )}
                  >
                    <MoreHorizontal className="h-3 w-3" />
                    <span className="hidden sm:inline">Delivery rules</span>
                  </button>
                </PopoverTrigger>
                <PopoverContent align="end" side="top" sideOffset={8} disablePortal className="w-[min(320px,calc(100vw-2rem))] space-y-4 p-4">
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-muted-foreground">Concurrency</p>
                    <Select
                      value={draft.concurrencyPolicy}
                      onValueChange={(concurrencyPolicy) => setDraft((current) => ({ ...current, concurrencyPolicy }))}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {concurrencyPolicies.map((value) => (
                          <SelectItem key={value} value={value}>{automationPolicyLabel(value, locale)}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs leading-5 text-muted-foreground">{automationPolicyDescription(concurrencyPolicyDescriptions, draft.concurrencyPolicy, locale)}</p>
                  </div>

                  <div className="space-y-2">
                    <p className="text-xs font-medium text-muted-foreground">Catch-up</p>
                    <Select
                      value={draft.catchUpPolicy}
                      onValueChange={(catchUpPolicy) => setDraft((current) => ({ ...current, catchUpPolicy }))}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {catchUpPolicies.map((value) => (
                          <SelectItem key={value} value={value}>{automationPolicyLabel(value, locale)}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs leading-5 text-muted-foreground">{automationPolicyDescription(catchUpPolicyDescriptions, draft.catchUpPolicy, locale)}</p>
                  </div>
                </PopoverContent>
              </Popover>
            </div>

            <div className="flex shrink-0 flex-col gap-2.5 border-t border-border/60 px-4 py-2.5 sm:px-5 lg:flex-row lg:items-center lg:justify-between">
              <p className="min-w-0 truncate text-xs text-muted-foreground">
                Runs automatically until paused.
              </p>
              <div className="flex items-center justify-end gap-2.5">
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  className="h-8 px-3 text-xs"
                  onClick={() => {
                    setComposerOpen(false);
                    setTemplatePickerOpen(false);
                    setAdvancedOpen(false);
                  }}
                  disabled={createAutomation.isPending}
                >
                  Cancel
                </Button>
                <div className="flex flex-col items-end gap-2">
                  <Button className="h-8 px-3 text-xs" size="sm" onClick={() => createAutomation.mutate()} disabled={createAutomation.isPending || !isDraftReady}>
                    {createAutomation.isPending ? "Creating..." : "Create"}
                    <ArrowRight className="ml-1 h-3 w-3" />
                  </Button>
                  {createAutomation.isError ? (
                    <p className="text-sm text-destructive">
                      {createAutomation.error instanceof Error ? createAutomation.error.message : "Failed to create automation"}
                    </p>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <div
        data-testid="automations-master-detail"
        className={cn(
          "flex h-full min-h-0 min-w-0 overflow-hidden transition-[gap] duration-300 ease-out motion-reduce:transition-none",
          detailCollapsed ? "gap-0" : "gap-2 md:gap-[9px]",
        )}
      >
        <section
          data-testid="automations-list-pane"
          className={cn(
            "workspace-main-card min-h-0 min-w-0 flex-1 overflow-hidden rounded-[var(--desktop-workspace-radius)]",
            automationId && "hidden min-[1100px]:block",
          )}
        >
        <header
          data-testid="automations-list-card-header"
          className="workspace-card-header workspace-main-header hidden h-12 shrink-0 items-center justify-between gap-3 px-4 md:flex"
        >
          <h2 className="truncate text-[14px] font-semibold text-foreground">Automations</h2>
          {detailCollapsed && automationId ? (
            <Button
              ref={expandDetailButtonRef}
              type="button"
              variant="ghost"
              size="icon"
              className="hidden h-8 w-8 text-muted-foreground hover:text-foreground min-[1100px]:inline-flex"
              aria-label="Expand automation detail"
              title="Expand automation detail"
              onClick={() => {
                setDetailCollapsed(false);
                window.requestAnimationFrame(() => collapseDetailButtonRef.current?.focus());
              }}
            >
              <PanelRight className="h-4 w-4" />
            </Button>
          ) : !automationId && selectedOrganizationId ? (
            <Button type="button" size="sm" className="px-4" onClick={() => openComposer()}>
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              Create automation
            </Button>
          ) : null}
        </header>
        <div className="scrollbar-auto-hide h-full min-h-0 overflow-y-auto px-1 py-4 sm:px-2 md:h-[calc(100%-3rem)] md:py-6">
        {error ? (
          <Card>
            <CardContent className="pt-6 text-sm text-destructive">
              {error instanceof Error ? error.message : "Failed to load automations"}
            </CardContent>
          </Card>
        ) : null}

      <div className="mx-auto w-full max-w-[1120px]">
        {(automations ?? []).length === 0 ? (
          <div className="mx-auto flex min-h-[min(620px,calc(100vh-14rem))] max-w-4xl flex-col items-center justify-center px-4 py-16 text-center md:py-20">
            <h1 className="text-xl font-semibold">No automations yet</h1>
            <p className="mt-2 max-w-xl text-sm text-muted-foreground">
              Turn repeated board work into a scheduled agent run. Choose a workflow or create your own.
            </p>
            <div
              data-testid="automation-template-grid"
              className="mt-8 grid w-full gap-3 sm:grid-cols-2 lg:grid-cols-3"
            >
              {automationTemplates.map((template) => {
                const title = localizeText(template.title, locale);
                const summary = localizeText(template.summary, locale);
                return (
                  <button
                    key={template.id}
                    type="button"
                    className="group min-h-[104px] rounded-md border border-border/70 bg-background/45 p-4 text-left transition-colors hover:border-border hover:bg-accent/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => openComposer(template)}
                  >
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-foreground">{title}</span>
                      <span className="mt-1 block text-sm leading-5 text-muted-foreground">{summary}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <div>
            <Tabs
              value={statusFilter}
              onValueChange={(value) => applyStatusFilter(value as AutomationStatusFilter)}
              className="gap-0"
            >
              <TabsList
                variant="line"
                aria-label="Automation status"
                className="mx-3 mb-3 h-9 border-b border-border px-0"
              >
                <TabsTrigger value="all">All</TabsTrigger>
                <TabsTrigger value="active">Active</TabsTrigger>
                <TabsTrigger value="paused">Paused</TabsTrigger>
              </TabsList>
            </Tabs>
            {filteredAutomations.length === 0 ? (
              <div className="flex min-h-56 items-center justify-center px-4 py-12 text-sm text-muted-foreground">
                No {statusFilter} automations
              </div>
            ) : (
              <div
                data-testid="automations-table-surface"
                className="mx-3 overflow-x-auto rounded-[var(--radius-md)] border border-border/70 bg-background/25 p-1"
              >
                <table className="min-w-full border-separate border-spacing-y-1 text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className={cn("px-3 py-2 font-medium", automationId && "hidden 2xl:table-cell")}>Project</th>
                  <th className={cn("px-3 py-2 font-medium", automationId && "hidden 2xl:table-cell")}>Assignee</th>
                  <th className="px-3 py-2 font-medium">Last run</th>
                  <th className="px-3 py-2 font-medium">Enabled</th>
                  <th className="w-12 px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {filteredAutomations.map((automation) => {
                  const enabled = automation.status === "active";
                  const isStatusPending = statusMutationAutomationId === automation.id;
                  const lastRunDisplay = automation.lastRun ? getAutomationRunDisplay(automation.lastRun, locale) : null;
                  const isSelected = automationId === automation.id;
                  return (
                    <tr
                      key={automation.id}
                      aria-current={isSelected ? "page" : undefined}
                      data-selected={isSelected ? "true" : undefined}
                      className={cn(
                        "group cursor-pointer align-middle [&>td]:transition-colors [&>td:first-child]:rounded-l-[var(--radius-sm)] [&>td:last-child]:rounded-r-[var(--radius-sm)] [&>td]:group-hover:bg-accent/50",
                        isSelected && "[&>td]:bg-accent/70 [&>td]:group-hover:bg-accent/70",
                      )}
                      onClick={() => {
                        setDetailCollapsed(false);
                        navigate(`/automations/${automation.id}`);
                      }}
                    >
                      <td className="px-3 py-2.5">
                        <div className="min-w-[180px]">
                          <span className="font-medium">
                            {automation.title}
                          </span>
                          {automation.status === "paused" && (
                            <div className="mt-1 text-xs text-muted-foreground">
                              paused
                            </div>
                          )}
                        </div>
                      </td>
                      <td className={cn("px-3 py-2.5", automationId && "hidden 2xl:table-cell")}>
                        {automation.projectId ? (
                          <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            <ProjectIcon
                              color={projectById.get(automation.projectId)?.color}
                              icon={projectById.get(automation.projectId)?.icon}
                              size="xs"
                            />
                            <span className="truncate">{projectById.get(automation.projectId)?.name ?? "Unknown"}</span>
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className={cn("px-3 py-2.5", automationId && "hidden 2xl:table-cell")}>
                        {automation.assigneeAgentId ? (() => {
                          const agent = agentById.get(automation.assigneeAgentId);
                          return agent ? (
                            <div className="flex items-center gap-2 text-sm text-muted-foreground">
                              <AgentIcon icon={agent.icon} role={agent.role} className="h-4 w-4 shrink-0" />
                              <span className="truncate">{formatChatAgentLabel(agent)}</span>
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">Unknown</span>
                          );
                        })() : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        {automation.lastRun && lastRunDisplay ? (
                          <div className={cn("space-y-1", automationId ? "min-w-[170px] max-w-[260px]" : "min-w-[260px] max-w-[380px]")}>
                            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                              <span className={cn(
                                "inline-flex shrink-0 items-center rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-none",
                                lastRunDisplay.statusClassName,
                              )}>
                                {lastRunDisplay.statusLabel}
                              </span>
                              <span className="tabular-nums text-xs text-muted-foreground">
                                {formatLastRunTimestamp(automation.lastRun.triggeredAt)}
                              </span>
                            </div>
                            <div className="truncate text-xs text-muted-foreground" title={lastRunDisplay.title}>
                              <span className="font-medium text-foreground/80">{lastRunDisplay.sourceLabel}</span>
                              {lastRunDisplay.context ? <span> · {lastRunDisplay.context}</span> : null}
                            </div>
                            {lastRunDisplay.destinationLabel ? (
                              <div className="truncate text-[11px] text-muted-foreground/80" title={lastRunDisplay.destinationLabel}>
                                {lastRunDisplay.destinationLabel}
                              </div>
                            ) : null}
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">Never</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center gap-3">
                          <ToggleSwitch
                            checked={enabled}
                            size="md"
                            tone="success"
                            aria-label={enabled ? `Disable ${automation.title}` : `Enable ${automation.title}`}
                            disabled={isStatusPending}
                            onClick={() =>
                              updateAutomationStatus.mutate({
                                id: automation.id,
                                status: nextAutomationStatus(!enabled),
                              })
                            }
                          />
                          <span className="text-xs text-muted-foreground">
                            {enabled ? "On" : "Off"}
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
                              <Pencil className="h-4 w-4" />
                              Edit
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              disabled={runningAutomationId === automation.id || !enabled}
                              onClick={() => runAutomation.mutate(automation.id)}
                            >
                              <Play className="h-4 w-4" />
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
                              disabled={isStatusPending}
                            >
                              {enabled ? <Pause className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
                              {enabled ? "Pause" : "Enable"}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              variant="destructive"
                              disabled={deleteAutomation.isPending}
                              onClick={async () => {
                                const confirmed = await confirm({
                                  title: `Delete "${automation.title}"?`,
                                  description: "This will permanently remove the automation and stop future runs.",
                                  confirmLabel: "Delete",
                                  tone: "destructive",
                                });
                                if (!confirmed) return;
                                deleteAutomation.mutate(automation.id);
                              }}
                            >
                              <Trash2 className="h-4 w-4" />
                              Delete
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
        )}
      </div>
        </div>
        </section>

      {automationId ? (
        <aside
          data-testid="automation-detail-pane"
          aria-label="Automation detail"
          aria-hidden={detailCollapsed || undefined}
          data-collapsed={detailCollapsed ? "true" : undefined}
          className={cn(
            "motion-resize workspace-main-card min-h-0 min-w-0 flex-1 overflow-hidden rounded-[var(--desktop-workspace-radius)] transition-[border-color] duration-[var(--motion-duration-standard)]",
            detailCollapsed
              ? "min-[1100px]:pointer-events-none min-[1100px]:invisible min-[1100px]:w-0 min-[1100px]:min-w-0 min-[1100px]:max-w-0 min-[1100px]:flex-none min-[1100px]:border-0 min-[1100px]:opacity-0"
              : "min-[1100px]:w-[48%] min-[1100px]:min-w-[500px] min-[1100px]:max-w-[860px] min-[1100px]:shrink-0 min-[1100px]:opacity-100",
          )}
        >
          <header
            data-testid="automation-detail-card-header"
            className={cn(
              "workspace-card-header workspace-main-header relative z-30 hidden h-12 shrink-0 items-center justify-between px-3 md:flex",
              detailCollapsed && "min-[1100px]:invisible",
            )}
          >
            <Button
              ref={collapseDetailButtonRef}
              type="button"
              variant="ghost"
              size="icon"
              className="hidden h-8 w-8 text-muted-foreground hover:text-foreground min-[1100px]:inline-flex"
              aria-label="Collapse automation detail"
              title="Collapse automation detail"
              onClick={() => {
                setDetailCollapsed(true);
                window.requestAnimationFrame(() => expandDetailButtonRef.current?.focus());
              }}
            >
              <PanelRight className="h-4 w-4" />
            </Button>
            <Button type="button" size="sm" className="px-4" onClick={() => openComposer()}>
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              Create automation
            </Button>
          </header>
          <div className={cn("h-full min-h-0 md:h-[calc(100%-3rem)]", detailCollapsed && "min-[1100px]:hidden")}>
            <AutomationDetail
              key={automationId}
              automationId={automationId}
              embedded
              onClose={() => navigate("/automations")}
            />
          </div>
        </aside>
      ) : null}
      </div>
    </div>
  );
}
