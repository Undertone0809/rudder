export const queryKeys = {
  organizations: {
    all: ["organizations"] as const,
    detail: (id: string) => ["organizations", id] as const,
    stats: ["organizations", "stats"] as const,
    resources: (orgId: string) => ["organizations", orgId, "resources"] as const,
    workspaceFiles: (orgId: string, directoryPath: string) =>
      ["organizations", orgId, "workspace-files", directoryPath] as const,
    workspaceFile: (orgId: string, filePath: string) =>
      ["organizations", orgId, "workspace-file", filePath] as const,
  },
  organizationSkills: {
    list: (orgId: string) => ["organization-skills", orgId] as const,
    detail: (orgId: string, skillId: string) => ["organization-skills", orgId, skillId] as const,
    updateStatus: (orgId: string, skillId: string) =>
      ["organization-skills", orgId, skillId, "update-status"] as const,
    file: (orgId: string, skillId: string, relativePath: string) =>
      ["organization-skills", orgId, skillId, "file", relativePath] as const,
  },
  agents: {
    list: (orgId: string) => ["agents", orgId] as const,
    nameSuggestion: (orgId: string) => ["agents", orgId, "name-suggestion"] as const,
    detail: (id: string) => ["agents", "detail", id] as const,
    runtimeState: (id: string) => ["agents", "runtime-state", id] as const,
    taskSessions: (id: string) => ["agents", "task-sessions", id] as const,
    skills: (id: string) => ["agents", "skills", id] as const,
    skillsAnalytics: (id: string) => ["agents", "skills-analytics", id] as const,
    instructionsBundle: (id: string) => ["agents", "instructions-bundle", id] as const,
    instructionsFile: (id: string, relativePath: string) =>
      ["agents", "instructions-bundle", id, "file", relativePath] as const,
    keys: (agentId: string) => ["agents", "keys", agentId] as const,
    configRevisions: (agentId: string) => ["agents", "config-revisions", agentId] as const,
    adapterModels: (orgId: string, agentRuntimeType: string) =>
      ["agents", orgId, "adapter-models", agentRuntimeType] as const,
  },
  issues: {
    list: (orgId: string) => ["issues", orgId] as const,
    children: (orgId: string, parentId: string) => ["issues", orgId, "children", parentId] as const,
    follows: (orgId: string) => ["issues", orgId, "follows"] as const,
    search: (orgId: string, q: string, projectId?: string) =>
      ["issues", orgId, "search", q, projectId ?? "__all-projects__"] as const,
    listAssignedToMe: (orgId: string) => ["issues", orgId, "assigned-to-me"] as const,
    listTouchedByMe: (orgId: string) => ["issues", orgId, "touched-by-me"] as const,
    listUnreadTouchedByMe: (orgId: string) => ["issues", orgId, "unread-touched-by-me"] as const,
    labels: (orgId: string) => ["issues", orgId, "labels"] as const,
    listByProject: (orgId: string, projectId: string) =>
      ["issues", orgId, "project", projectId] as const,
    detail: (id: string) => ["issues", "detail", id] as const,
    comments: (issueId: string) => ["issues", "comments", issueId] as const,
    attachments: (issueId: string) => ["issues", "attachments", issueId] as const,
    documents: (issueId: string) => ["issues", "documents", issueId] as const,
    documentRevisions: (issueId: string, key: string) => ["issues", "document-revisions", issueId, key] as const,
    activity: (issueId: string) => ["issues", "activity", issueId] as const,
    runs: (issueId: string) => ["issues", "runs", issueId] as const,
    approvals: (issueId: string) => ["issues", "approvals", issueId] as const,
    liveRuns: (issueId: string) => ["issues", "live-runs", issueId] as const,
    activeRun: (issueId: string) => ["issues", "active-run", issueId] as const,
    workProducts: (issueId: string) => ["issues", "work-products", issueId] as const,
  },
  chats: {
    list: (orgId: string, status: "active" | "resolved" | "archived" | "all" = "active") =>
      ["chats", orgId, status] as const,
    detail: (chatId: string) => ["chats", "detail", chatId] as const,
    messages: (chatId: string) => ["chats", "messages", chatId] as const,
  },
  messenger: {
    threads: (orgId: string) => ["messenger", orgId, "threads"] as const,
    issues: (orgId: string) => ["messenger", orgId, "issues"] as const,
    approvals: (orgId: string) => ["messenger", orgId, "approvals"] as const,
    system: (orgId: string, threadKind: string) => ["messenger", orgId, "system", threadKind] as const,
  },
  automations: {
    list: (orgId: string) => ["automations", orgId] as const,
    detail: (id: string) => ["automations", "detail", id] as const,
    runs: (id: string) => ["automations", "runs", id] as const,
    activity: (orgId: string, id: string) => ["automations", "activity", orgId, id] as const,
  },
  calendar: {
    sources: (orgId: string) => ["calendar", orgId, "sources"] as const,
    events: (
      orgId: string,
      start: string,
      end: string,
      agentIds?: string[],
      sourceIds?: string[],
      eventKinds?: string[],
      statuses?: string[],
    ) =>
      [
        "calendar",
        orgId,
        "events",
        start,
        end,
        agentIds?.join(",") ?? "",
        sourceIds?.join(",") ?? "",
        eventKinds?.join(",") ?? "",
        statuses?.join(",") ?? "",
      ] as const,
  },
  executionWorkspaces: {
    list: (orgId: string, filters?: Record<string, string | boolean | undefined>) =>
      ["execution-workspaces", orgId, filters ?? {}] as const,
    detail: (id: string) => ["execution-workspaces", "detail", id] as const,
  },
  projects: {
    list: (orgId: string) => ["projects", orgId] as const,
    detail: (id: string) => ["projects", "detail", id] as const,
    resources: (id: string) => ["projects", "detail", id, "resources"] as const,
  },
  goals: {
    list: (orgId: string) => ["goals", orgId] as const,
    detail: (id: string) => ["goals", "detail", id] as const,
    dependencies: (id: string) => ["goals", "detail", id, "dependencies"] as const,
    activity: (orgId: string, id: string) => ["goals", "activity", orgId, id] as const,
  },
  budgets: {
    overview: (orgId: string) => ["budgets", "overview", orgId] as const,
  },
  approvals: {
    list: (orgId: string, status?: string) =>
      ["approvals", orgId, status] as const,
    detail: (approvalId: string) => ["approvals", "detail", approvalId] as const,
    comments: (approvalId: string) => ["approvals", "comments", approvalId] as const,
    issues: (approvalId: string) => ["approvals", "issues", approvalId] as const,
  },
  access: {
    joinRequests: (orgId: string, status: string = "pending_approval") =>
      ["access", "join-requests", orgId, status] as const,
    invite: (token: string) => ["access", "invite", token] as const,
    currentBoardAccess: ["access", "current-board-access"] as const,
  },
  auth: {
    session: ["auth", "session"] as const,
  },
  instance: {
    profileSettings: ["instance", "profile-settings"] as const,
    generalSettings: ["instance", "general-settings"] as const,
    notificationSettings: ["instance", "notification-settings"] as const,
    langfuseSettings: ["instance", "langfuse-settings"] as const,
    schedulerHeartbeats: ["instance", "scheduler-heartbeats"] as const,
  },
  health: ["health"] as const,
  secrets: {
    list: (orgId: string) => ["secrets", orgId] as const,
    providers: (orgId: string) => ["secret-providers", orgId] as const,
  },
  dashboard: (orgId: string) => ["dashboard", orgId] as const,
  dashboardSkillsAnalytics: (orgId: string) => ["dashboard", orgId, "skills-analytics"] as const,
  sidebarBadges: (orgId: string) => ["sidebar-badges", orgId] as const,
  activity: (orgId: string) => ["activity", orgId] as const,
  costs: (orgId: string, from?: string, to?: string) =>
    ["costs", orgId, from, to] as const,
  usageByProvider: (orgId: string, from?: string, to?: string) =>
    ["usage-by-provider", orgId, from, to] as const,
  usageByBiller: (orgId: string, from?: string, to?: string) =>
    ["usage-by-biller", orgId, from, to] as const,
  financeSummary: (orgId: string, from?: string, to?: string) =>
    ["finance-summary", orgId, from, to] as const,
  financeByBiller: (orgId: string, from?: string, to?: string) =>
    ["finance-by-biller", orgId, from, to] as const,
  financeByKind: (orgId: string, from?: string, to?: string) =>
    ["finance-by-kind", orgId, from, to] as const,
  financeEvents: (orgId: string, from?: string, to?: string, limit: number = 100) =>
    ["finance-events", orgId, from, to, limit] as const,
  usageWindowSpend: (orgId: string) =>
    ["usage-window-spend", orgId] as const,
  usageQuotaWindows: (orgId: string) =>
    ["usage-quota-windows", orgId] as const,
  heartbeats: (orgId: string, agentId?: string) =>
    ["heartbeats", orgId, agentId] as const,
  runDetail: (runId: string) => ["heartbeat-run", runId] as const,
  runWorkspaceOperations: (runId: string) => ["heartbeat-run", runId, "workspace-operations"] as const,
  liveRuns: (orgId: string) => ["live-runs", orgId] as const,
  runIssues: (runId: string) => ["run-issues", runId] as const,
  org: (orgId: string) => ["org", orgId] as const,
  skills: {
    available: ["skills", "available"] as const,
  },
  plugins: {
    all: ["plugins"] as const,
    examples: ["plugins", "examples"] as const,
    detail: (pluginId: string) => ["plugins", pluginId] as const,
    health: (pluginId: string) => ["plugins", pluginId, "health"] as const,
    uiContributions: ["plugins", "ui-contributions"] as const,
    config: (pluginId: string) => ["plugins", pluginId, "config"] as const,
    dashboard: (pluginId: string) => ["plugins", pluginId, "dashboard"] as const,
    logs: (pluginId: string) => ["plugins", pluginId, "logs"] as const,
  },
};
