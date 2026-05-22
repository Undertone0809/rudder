import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import {
  ArrowRight,
  Bot,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  FolderOpen,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Repeat,
  Trash2,
  X,
} from "lucide-react";
import { automationsApi } from "../api/automations";
import { agentsApi } from "../api/agents";
import { chatsApi } from "../api/chats";
import { issuesApi } from "../api/issues";
import { organizationSkillsApi } from "../api/organizationSkills";
import { projectsApi } from "../api/projects";
import { useOrganization } from "../context/OrganizationContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useDialog } from "../context/DialogContext";
import { useToast } from "../context/ToastContext";
import { formatChatAgentLabel } from "../lib/agent-labels";
import { buildAgentSkillMentionOptions } from "../lib/agent-skill-mentions";
import { buildMarkdownMentionOptions } from "../lib/markdown-mention-options";
import { projectColorBackgroundStyle } from "../lib/project-colors";
import { queryKeys } from "../lib/queryKeys";
import { getRecentAssigneeIds, sortAgentsByRecency, trackRecentAssignee } from "../lib/recent-assignees";
import { cn, formatDateTimeSeconds, getUiLocale } from "../lib/utils";
import { useScrollbarActivityRef } from "../hooks/useScrollbarActivityRef";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgentIcon } from "../components/AgentIconPicker";
import { InlineEntitySelector, type InlineEntityOption } from "../components/InlineEntitySelector";
import { MarkdownEditor, type MarkdownEditorRef } from "../components/MarkdownEditor";
import { ScheduleEditor, describeSchedule } from "../components/ScheduleEditor";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ToggleSwitch } from "@/components/ui/toggle-switch";

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
const automationComposerChipClass =
  "h-7 rounded-[5px] px-2 text-xs font-medium";
const automationComposerChipIconClass =
  "h-3 w-3 shrink-0 text-muted-foreground";

type AutomationOutputMode = "track_issue" | "chat_output";

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
    id: "dependency-audit",
    title: { en: "Dependency audit", "zh-CN": "依赖审计" },
    summary: { en: "Scan for security and maintenance risks.", "zh-CN": "检查依赖安全和维护风险。" },
    scheduleCron: "0 11 * * 2",
    outputMode: "track_issue",
    description: {
      en: [
        "1. Inspect dependency and lockfile changes since the last audit.",
        "2. Check for known vulnerabilities, deprecated packages, and risky major updates.",
        "3. Separate urgent fixes from routine maintenance.",
        "4. Create follow-up issues only when there is a concrete owner and recommended action.",
      ].join("\n"),
      "zh-CN": [
        "1. 检查上次审计后的依赖和 lockfile 变化。",
        "2. 查找已知漏洞、废弃包和高风险 major 升级。",
        "3. 区分紧急修复和常规维护。",
        "4. 只有在 owner 和建议动作明确时创建后续任务。",
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
    title: { en: "Daily standup", "zh-CN": "日会" },
    summary: { en: "Collect blockers, priorities, and handoffs for today.", "zh-CN": "汇总今天的阻塞、重点和交接事项。" },
    scheduleCron: "30 9 * * 1-5",
    outputMode: "chat_output",
    description: {
      en: [
        "1. Review active issues, latest comments, and runs updated since the previous workday.",
        "2. Summarize what each active owner completed, plans next, and is blocked by.",
        "3. Keep the output short enough for a daily standup.",
        "4. Post the summary to chat and create tracked work only for concrete blockers.",
      ].join("\n"),
      "zh-CN": [
        "1. 查看上一个工作日以来更新的进行中任务、最新评论和运行记录。",
        "2. 汇总每个活跃 owner 已完成、下一步计划和阻塞项。",
        "3. 输出保持日会可读的长度。",
        "4. 将摘要发送到 chat；只有明确阻塞才创建可跟踪任务。",
      ].join("\n"),
    },
  },
];

const blankAutomationTemplate: AutomationTemplate = {
  id: "custom",
  title: { en: "", "zh-CN": "" },
  summary: { en: "Create a custom recurring workflow.", "zh-CN": "创建自定义循环工作流。" },
  description: {
    en: [
      "# Goal",
      "What should the agent accomplish?",
      "",
      "# Context",
      "Who is this for? Any constraints?",
      "",
      "# Steps",
      "1. ...",
      "2. ...",
    ].join("\n"),
    "zh-CN": [
      "# 目标",
      "智能体需要完成什么？",
      "",
      "# 背景",
      "服务谁？有哪些约束？",
      "",
      "# 步骤",
      "1. ...",
      "2. ...",
    ].join("\n"),
  },
  scheduleCron: "0 9 * * *",
  outputMode: "track_issue",
};

function localizeText(text: LocalizedText, locale = getUiLocale()) {
  return text[locale] ?? text.en;
}

function outputInstruction(mode: AutomationOutputMode, locale = getUiLocale()) {
  if (mode === "chat_output") {
    return locale === "zh-CN"
      ? "输出：将结果发送到相关 Rudder chat 对话；只有出现明确阻塞或后续动作时才创建任务。"
      : "Output: send the result to the relevant Rudder chat conversation; create tracked work only for concrete blockers or follow-up actions.";
  }
  return locale === "zh-CN"
    ? "输出：创建或更新 board 可跟踪任务，确保结果可以被 review。"
    : "Output: create or update board-tracked work so the result can be reviewed.";
}

function withOutputInstruction(description: string, mode: AutomationOutputMode, locale = getUiLocale()) {
  const instruction = outputInstruction(mode, locale);
  return `${description.trim()}\n\n${instruction}`;
}

function removeOutputInstruction(description: string) {
  return description
    .replace(/\n*Output: create or update board-tracked work so the result can be reviewed\.\s*$/u, "")
    .replace(/\n*Output: send the result to the relevant Rudder chat conversation; create tracked work only for concrete blockers or follow-up actions\.\s*$/u, "")
    .replace(/\n*输出：创建或更新 board 可跟踪任务，确保结果可以被 review。\s*$/u, "")
    .replace(/\n*输出：将结果发送到相关 Rudder chat 对话；只有出现明确阻塞或后续动作时才创建任务。\s*$/u, "")
    .trim();
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
  const { selectedOrganizationId, selectedOrganization } = useOrganization();
  const { setBreadcrumbs, setHeaderActions } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { confirm } = useDialog();
  const { pushToast } = useToast();
  const descriptionEditorRef = useRef<MarkdownEditorRef>(null);
  const titleInputRef = useRef<HTMLTextAreaElement | null>(null);
  const assigneeSelectorRef = useRef<HTMLButtonElement | null>(null);
  const projectSelectorRef = useRef<HTMLButtonElement | null>(null);
  const composerBodyScrollRef = useScrollbarActivityRef("rudder:automation-composer-body");
  const composerMainScrollRef = useScrollbarActivityRef("rudder:automation-composer-main");
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
    scheduleCron: "0 9 * * *",
    outputMode: "track_issue" as AutomationOutputMode,
    chatConversationId: "",
    allowAssigneeChatMismatch: false,
  });

  const resetDraft = useCallback(() => {
    setDraft({
      title: "",
      description: "",
      projectId: "",
      assigneeAgentId: "",
      priority: "medium",
      concurrencyPolicy: "coalesce_if_active",
      catchUpPolicy: "skip_missed",
      scheduleCron: "0 9 * * *",
      outputMode: "track_issue",
      chatConversationId: "",
      allowAssigneeChatMismatch: false,
    });
  }, []);

  const openComposer = useCallback((template: AutomationTemplate = blankAutomationTemplate) => {
    const locale = getUiLocale();
    setDraft((current) => ({
      ...current,
      title: localizeText(template.title, locale),
      description: withOutputInstruction(localizeText(template.description, locale), template.outputMode, locale),
      scheduleCron: template.scheduleCron,
      outputMode: template.outputMode,
      chatConversationId: "",
      allowAssigneeChatMismatch: false,
    }));
    setAdvancedOpen(false);
    setComposerOpen(true);
  }, []);

  const selectOutputMode = useCallback((outputMode: AutomationOutputMode) => {
    setDraft((current) => ({
      ...current,
      outputMode,
      chatConversationId: outputMode === "chat_output" ? current.chatConversationId : "",
      allowAssigneeChatMismatch: outputMode === "chat_output" ? current.allowAssigneeChatMismatch : false,
      description: withOutputInstruction(removeOutputInstruction(current.description), outputMode),
    }));
  }, []);

  useEffect(() => {
    setBreadcrumbs([{ label: "Automations" }]);
  }, [setBreadcrumbs]);

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
  const { data: chats } = useQuery({
    queryKey: queryKeys.chats.list(selectedOrganizationId!, "active"),
    queryFn: () => chatsApi.list(selectedOrganizationId!, "active"),
    enabled: !!selectedOrganizationId && composerOpen && draft.outputMode === "chat_output",
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
      const automation = await automationsApi.create(selectedOrganizationId!, {
        title: draft.title,
        description: draft.description.trim() || null,
        projectId: draft.projectId || null,
        assigneeAgentId: draft.assigneeAgentId,
        priority: draft.priority,
        concurrencyPolicy: draft.concurrencyPolicy,
        catchUpPolicy: draft.catchUpPolicy,
        outputMode: draft.outputMode,
        chatConversationId: draft.outputMode === "chat_output" ? draft.chatConversationId || null : null,
        allowAssigneeChatMismatch: draft.allowAssigneeChatMismatch,
      });

      if (draft.scheduleCron.trim()) {
        await automationsApi.createTrigger(automation.id, {
          kind: "schedule",
          label: describeSchedule(draft.scheduleCron),
          cronExpression: draft.scheduleCron.trim(),
          timezone: getLocalTimezone(),
        });
      }

      return automation;
    },
    onSuccess: async (automation) => {
      resetDraft();
      setComposerOpen(false);
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
  const chatOptions = useMemo<InlineEntityOption[]>(
    () =>
      (chats ?? []).map((chat) => ({
        id: chat.id,
        label: chat.title,
        searchText: chat.summary ?? chat.latestReplyPreview ?? "",
      })),
    [chats],
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
  const currentChat = draft.chatConversationId
    ? (chats ?? []).find((chat) => chat.id === draft.chatConversationId) ?? null
    : null;
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
              <Button
                variant="ghost"
                size="icon-xs"
                type="button"
                className="shrink-0 text-muted-foreground"
                onClick={() => {
                  setComposerOpen(false);
                  setAdvancedOpen(false);
                }}
                disabled={createAutomation.isPending}
                aria-label="Close automation composer"
              >
                <X className="h-3.5 w-3.5" />
              </Button>
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

                <MarkdownEditor
                  ref={descriptionEditorRef}
                  value={draft.description}
                  onChange={(description) => setDraft((current) => ({ ...current, description }))}
                  mentions={mentionOptions}
                  placeholder="Add prompt e.g. look for crashes in Sentry"
                  bordered={false}
                  contentClassName="min-h-[320px] text-[15px] leading-7 text-foreground/90 placeholder:text-muted-foreground/55 md:min-h-[440px]"
                  onSubmit={() => {
                    if (!createAutomation.isPending && isDraftReady) {
                      createAutomation.mutate();
                    }
                  }}
                />
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
                  setDraft((current) => ({ ...current, assigneeAgentId }));
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
                      <span
                        className="h-3 w-3 shrink-0 rounded-[3px]"
                        style={projectColorBackgroundStyle(currentProject.color)}
                      />
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
                      <span
                        className="h-3 w-3 shrink-0 rounded-[3px]"
                        style={projectColorBackgroundStyle(project?.color)}
                      />
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
                    <span className="truncate">{draft.scheduleCron.trim() ? describeSchedule(draft.scheduleCron) : "No schedule set"}</span>
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
                    {draft.scheduleCron.trim() ? describeSchedule(draft.scheduleCron) : "No schedule set"}
                  </p>
                </PopoverContent>
              </Popover>

              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
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
                    <span>{draft.outputMode === "track_issue" ? "Track as issue" : "Send to chat"}</span>
                    <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground/80" />
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" side="top" sideOffset={8} disablePortal className="w-[min(320px,calc(100vw-2rem))] space-y-2 p-2">
                  <p className="px-1 pt-1 text-xs font-medium text-muted-foreground">Run output</p>
                  {([
                    {
                      value: "track_issue" as const,
                      icon: CheckCircle2,
                      title: "Track as issue",
                      summary: "Each run opens board-tracked work",
                    },
                    {
                      value: "chat_output" as const,
                      icon: MessageSquare,
                      title: "Send to chat",
                      summary: "Post summary to a chat conversation",
                    },
                  ]).map((option) => {
                    const Icon = option.icon;
                    const selected = draft.outputMode === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
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
                <InlineEntitySelector
                  value={draft.chatConversationId}
                  options={chatOptions}
                  placeholder="New chat"
                  noneLabel="New chat"
                  searchPlaceholder="Search chats..."
                  emptyMessage="No active chats found."
                  className="h-8 max-w-[240px] bg-transparent px-2 text-sm"
                  disablePortal
                  side="top"
                  sideOffset={8}
                  onChange={(chatConversationId) => setDraft((current) => ({
                    ...current,
                    chatConversationId,
                    allowAssigneeChatMismatch: false,
                  }))}
                  renderTriggerValue={(option) =>
                    option && currentChat ? (
                      <>
                        <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate">{option.label}</span>
                      </>
                    ) : (
                      <>
                        <Plus className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate">New chat</span>
                      </>
                    )
                  }
                  renderOption={(option) =>
                    option.id ? (
                      <>
                        <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate">{option.label}</span>
                      </>
                    ) : (
                      <>
                        <Plus className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate">{option.label}</span>
                      </>
                    )
                  }
                />
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
                          <SelectItem key={value} value={value}>{value.replaceAll("_", " ")}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs leading-5 text-muted-foreground">{concurrencyPolicyDescriptions[draft.concurrencyPolicy]}</p>
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
                          <SelectItem key={value} value={value}>{value.replaceAll("_", " ")}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs leading-5 text-muted-foreground">{catchUpPolicyDescriptions[draft.catchUpPolicy]}</p>
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
                    setAdvancedOpen(false);
                  }}
                  disabled={createAutomation.isPending}
                >
                  Cancel
                </Button>
                <div className="flex flex-col items-end gap-2">
                  <Button className="h-8 px-3 text-xs" size="sm" onClick={() => createAutomation.mutate()} disabled={createAutomation.isPending || !isDraftReady}>
                    {createAutomation.isPending ? "Creating..." : "Create automation"}
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

      {error ? (
        <Card>
          <CardContent className="pt-6 text-sm text-destructive">
            {error instanceof Error ? error.message : "Failed to load automations"}
          </CardContent>
        </Card>
      ) : null}

      <div>
        {(automations ?? []).length === 0 ? (
          <div className="mx-auto flex min-h-[min(680px,calc(100vh-12rem))] max-w-5xl flex-col items-center justify-center px-4 py-12 text-center">
            <h1 className="text-xl font-semibold">No automations yet</h1>
            <p className="mt-2 max-w-xl text-sm text-muted-foreground">
              Turn repeated board work into a scheduled agent run. Choose a workflow or create your own.
            </p>
            <div
              data-testid="automation-template-grid"
              className="mt-8 grid w-full gap-3 sm:grid-cols-2 lg:grid-cols-3"
            >
              {automationTemplates.map((template) => {
                const title = localizeText(template.title);
                const summary = localizeText(template.summary);
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
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b border-border">
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">Project</th>
                  <th className="px-3 py-2 font-medium">Assignee</th>
                  <th className="px-3 py-2 font-medium">Last run</th>
                  <th className="px-3 py-2 font-medium">Enabled</th>
                  <th className="w-12 px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {(automations ?? []).map((automation) => {
                  const enabled = automation.status === "active";
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
                          {automation.status === "paused" && (
                            <div className="mt-1 text-xs text-muted-foreground">
                              paused
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
                      <td className="px-3 py-2.5 text-muted-foreground">
                        <span className="tabular-nums">{formatLastRunTimestamp(automation.lastRun?.triggeredAt)}</span>
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
                              Edit
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              disabled={runningAutomationId === automation.id || !enabled}
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
                              disabled={isStatusPending}
                            >
                              {enabled ? "Pause" : "Enable"}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className="text-destructive focus:text-destructive"
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
                              <Trash2 className="mr-2 h-3.5 w-3.5" />
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
    </div>
  );
}
