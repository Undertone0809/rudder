export const ORGANIZATION_STATUSES = ["active", "paused", "archived"] as const;
export type OrganizationStatus = (typeof ORGANIZATION_STATUSES)[number];

export const ORGANIZATION_INTELLIGENCE_PROFILE_PURPOSES = ["lightweight", "reasoning"] as const;
export type OrganizationIntelligenceProfilePurpose = (typeof ORGANIZATION_INTELLIGENCE_PROFILE_PURPOSES)[number];

export const ORGANIZATION_INTELLIGENCE_PROFILE_STATUSES = ["configured", "disabled", "invalid"] as const;
export type OrganizationIntelligenceProfileStatus = (typeof ORGANIZATION_INTELLIGENCE_PROFILE_STATUSES)[number];

export const DEPLOYMENT_MODES = ["local_trusted", "authenticated"] as const;
export type DeploymentMode = (typeof DEPLOYMENT_MODES)[number];

export const DEPLOYMENT_EXPOSURES = ["private", "public"] as const;
export type DeploymentExposure = (typeof DEPLOYMENT_EXPOSURES)[number];

export const AUTH_REQUIREMENTS = ["optional", "required"] as const;
export type AuthRequirement = (typeof AUTH_REQUIREMENTS)[number];

export const LOCAL_RUNTIME_TRUST_LEVELS = ["trusted", "untrusted"] as const;
export type LocalRuntimeTrust = (typeof LOCAL_RUNTIME_TRUST_LEVELS)[number];

export function authRequirementForDeploymentMode(mode: DeploymentMode): AuthRequirement {
  return mode === "authenticated" ? "required" : "optional";
}

export function localRuntimeTrustForDeploymentMode(mode: DeploymentMode): LocalRuntimeTrust {
  return mode === "local_trusted" ? "trusted" : "untrusted";
}

export const AUTH_BASE_URL_MODES = ["auto", "explicit"] as const;
export type AuthBaseUrlMode = (typeof AUTH_BASE_URL_MODES)[number];

export const AGENT_STATUSES = [
  "active",
  "paused",
  "idle",
  "running",
  "error",
  "pending_approval",
  "terminated",
] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export const AGENT_RUN_CONCURRENCY_DEFAULT = 8;
export const AGENT_RUN_CONCURRENCY_MIN = 1;
export const AGENT_RUN_CONCURRENCY_MAX = 10;

export const AGENT_RUN_SCENES = [
  "issue",
  "chat",
  "automation",
  "review",
  "heartbeat",
] as const;
export type AgentRunScene = (typeof AGENT_RUN_SCENES)[number];

export const AGENT_RUN_TARGET_TYPES = [
  "issue",
  "chat_conversation",
  "chat_message",
  "automation_run",
  "wakeup_request",
  "manual",
] as const;
export type AgentRunTargetType = (typeof AGENT_RUN_TARGET_TYPES)[number];

export const AGENT_RUNTIME_TYPES = [
  "process",
  "http",
  "claude_local",
  "codex_local",
  "gemini_local",
  "opencode_local",
  "pi_local",
  "cursor",
  "openclaw_gateway",
  "hermes_gateway",
  "hermes_local",
] as const;
export type AgentRuntimeType = (typeof AGENT_RUNTIME_TYPES)[number];

export const AGENT_ROLES = [
  "ceo",
  "cto",
  "cmo",
  "cfo",
  "engineer",
  "designer",
  "pm",
  "qa",
  "devops",
  "researcher",
  "general",
] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export const AGENT_ROLE_LABELS: Record<AgentRole, string> = {
  ceo: "CEO",
  cto: "CTO",
  cmo: "CMO",
  cfo: "CFO",
  engineer: "Engineer",
  designer: "Designer",
  pm: "PM",
  qa: "QA",
  devops: "DevOps",
  researcher: "Researcher",
  general: "General",
};

export const AGENT_ICON_NAMES = [
  "bot",
  "cpu",
  "brain",
  "zap",
  "rocket",
  "code",
  "terminal",
  "shield",
  "eye",
  "search",
  "wrench",
  "hammer",
  "lightbulb",
  "sparkles",
  "star",
  "heart",
  "flame",
  "bug",
  "cog",
  "database",
  "globe",
  "lock",
  "mail",
  "message-square",
  "file-code",
  "git-branch",
  "package",
  "puzzle",
  "target",
  "wand",
  "atom",
  "circuit-board",
  "radar",
  "swords",
  "telescope",
  "microscope",
  "crown",
  "gem",
  "hexagon",
  "pentagon",
  "fingerprint",
] as const;
export type AgentIconName = (typeof AGENT_ICON_NAMES)[number];

export const AGENT_OREO_ICON_PREFIX = "oreo:" as const;

export const AGENT_OREO_SHAPE_IDS = [
  "bloom",
  "silk",
  "flare",
  "nova",
  "void",
  "jade",
] as const;
export type AgentOreoShapeId = (typeof AGENT_OREO_SHAPE_IDS)[number];

export const AGENT_OREO_PALETTE_IDS = [
  "rose-milk",
  "peach-cream",
  "mint-milk",
  "aurora-pink",
  "lilac-silk",
  "blue-cream",
  "jade-cream",
  "coral-mist",
  "lemon-mint",
  "violet-peach",
  "magenta-void",
  "teal-void",
  "amber-dusk",
  "sky-melon",
  "grapefruit",
  "lavender-lime",
  "aqua-orchid",
  "honeydew",
  "plum-gold",
  "ice-berry",
  "apricot-mint",
  "candy-blue",
  "raspberry-cream",
  "spring-glow",
  "sunset-punch",
  "moon-pearl",
  "seafoam-rose",
  "blueberry-milk",
  "mango-iris",
  "forest-neon",
  "cotton-candy",
  "lime-sorbet",
  "cherry-cola",
  "opal-mint",
  "peach-lilac",
  "cyan-flame",
  "orchid-night",
  "pistachio-blush",
  "lagoon-gold",
  "vanilla-sky",
] as const;
export type AgentOreoPaletteId = (typeof AGENT_OREO_PALETTE_IDS)[number];

export const AGENT_OREO_DEFAULT_SHAPE_ID: AgentOreoShapeId = "bloom";
export const AGENT_OREO_DEFAULT_PALETTE_ID: AgentOreoPaletteId = "rose-milk";

export const AGENT_DICEBEAR_NOTIONISTS_ICON_PREFIX = "dicebear:notionists:" as const;

export const AGENT_AVATAR_BACKGROUND_PRESET_IDS = [
  "mist",
  "slate",
  "sky",
  "mint",
  "peach",
  "violet",
] as const;
export type AgentAvatarBackgroundPresetId = (typeof AGENT_AVATAR_BACKGROUND_PRESET_IDS)[number];

export const ISSUE_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "blocked",
  "cancelled",
] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export const ISSUE_PRIORITIES = ["critical", "high", "medium", "low"] as const;
export type IssuePriority = (typeof ISSUE_PRIORITIES)[number];

export const ISSUE_ORIGIN_KINDS = ["manual", "automation_execution", "agent_integration", "agent_issue_creation"] as const;
export type IssueOriginKind = (typeof ISSUE_ORIGIN_KINDS)[number];

export const AGENT_INTEGRATION_PROVIDERS = ["feishu"] as const;
export type AgentIntegrationProvider = (typeof AGENT_INTEGRATION_PROVIDERS)[number];

export const AGENT_INTEGRATION_STATUSES = ["active", "revoked", "error"] as const;
export type AgentIntegrationStatus = (typeof AGENT_INTEGRATION_STATUSES)[number];

export const AGENT_INTEGRATION_TRANSPORTS = ["long_connection", "webhook"] as const;
export type AgentIntegrationTransport = (typeof AGENT_INTEGRATION_TRANSPORTS)[number];

export const AGENT_INTEGRATION_PROVIDER_REGIONS = ["feishu_cn", "lark_global"] as const;
export type AgentIntegrationProviderRegion = (typeof AGENT_INTEGRATION_PROVIDER_REGIONS)[number];

export const AGENT_INTEGRATION_CHAT_TYPES = ["p2p", "group"] as const;
export type AgentIntegrationChatType = (typeof AGENT_INTEGRATION_CHAT_TYPES)[number];

export const AGENT_INTEGRATION_DROP_REASONS = [
  "unbound_user",
  "non_org_member",
  "not_addressed_in_group",
  "duplicate",
  "revoked_installation",
  "invalid_event",
  "agent_unavailable",
  "unsupported_message_type",
] as const;
export type AgentIntegrationDropReason = (typeof AGENT_INTEGRATION_DROP_REASONS)[number];

export const AGENT_INTEGRATION_OUTBOUND_STATUSES = ["pending", "streaming", "final", "error"] as const;
export type AgentIntegrationOutboundStatus = (typeof AGENT_INTEGRATION_OUTBOUND_STATUSES)[number];

export const RUDDER_AGENT_V1_MCP_SERVER_NAME = "rudder-tools" as const;
export const RUDDER_BROWSER_MCP_SERVER_NAME = "rudder-browser" as const;
export const RUDDER_AGENT_V1_MCP_TOOL_NAMES = [
  "rudder_agent_me",
  "rudder_agent_inbox",
  "rudder_organization_members_list",
  "rudder_agent_capabilities",
  "rudder_agent_update",
  "rudder_agent_skills_create",
  "rudder_agent_skills_enable",
  "rudder_agent_skills_sync",
  "rudder_goal_list",
  "rudder_goal_context",
  "rudder_goal_progress",
  "rudder_goal_checkpoint",
  "rudder_goal_change_propose",
  "rudder_goal_result_propose",
  "rudder_issue_get",
  "rudder_issue_list",
  "rudder_issue_search",
  "rudder_issue_context",
  "rudder_issue_checkout",
  "rudder_issue_comment",
  "rudder_issue_comments_list",
  "rudder_issue_comments_get",
  "rudder_issue_update",
  "rudder_issue_review",
  "rudder_issue_commit",
  "rudder_issue_done",
  "rudder_issue_block",
  "rudder_project_list",
  "rudder_project_get",
  "rudder_project_create",
  "rudder_project_update",
  "rudder_user_activity",
  "rudder_library_file_list",
  "rudder_library_file_get",
  "rudder_library_file_ref",
  "rudder_library_file_link",
  "rudder_library_file_put",
  "rudder_issue_create",
  "rudder_approval_get",
  "rudder_approval_issues",
  "rudder_approval_comment",
  "rudder_skill_list",
  "rudder_skill_search",
  "rudder_skill_get",
  "rudder_skill_file",
  "rudder_skill_import",
  "rudder_skill_scan_local",
  "rudder_skill_scan_projects",
  "rudder_plugin_search",
  "rudder_plugin_get",
  "rudder_browser_tabs",
  "rudder_browser_user_tabs",
  "rudder_browser_open",
  "rudder_browser_navigate",
  "rudder_browser_back",
  "rudder_browser_forward",
  "rudder_browser_reload",
  "rudder_browser_viewport",
  "rudder_browser_visibility",
  "rudder_browser_snapshot",
  "rudder_browser_locator",
  "rudder_browser_cua",
  "rudder_browser_dom_cua",
  "rudder_browser_dialog",
  "rudder_browser_clipboard",
  "rudder_browser_logs",
  "rudder_browser_download",
  "rudder_browser_assets",
  "rudder_browser_content",
  "rudder_browser_wait",
  "rudder_browser_read",
  "rudder_browser_click",
  "rudder_browser_type",
  "rudder_browser_screenshot",
  "rudder_browser_close",
  "rudder_automation_list",
  "rudder_automation_get",
  "rudder_automation_runs",
  "rudder_automation_triggers_list",
  "rudder_automation_triggers_create",
  "rudder_automation_triggers_update",
  "rudder_automation_triggers_delete",
  "rudder_automation_triggers_rotate_secret",
  "rudder_automation_create",
  "rudder_automation_update",
  "rudder_automation_enable",
  "rudder_automation_disable",
  "rudder_automation_run",
  "rudder_chat_list",
  "rudder_chat_search",
  "rudder_chat_get",
  "rudder_chat_messages",
  "rudder_chat_transcript",
  "rudder_chat_read",
  "rudder_chat_create",
  "rudder_chat_send",
  "rudder_chat_archive",
  "rudder_runs_list",
  "rudder_runs_by_skill",
  "rudder_runs_get",
  "rudder_runs_events",
  "rudder_runs_log",
  "rudder_runs_transcript",
  "rudder_runs_errors",
  "rudder_runs_cancel",
  "rudder_runs_retry",
] as const;
export type RudderAgentV1McpToolName = (typeof RUDDER_AGENT_V1_MCP_TOOL_NAMES)[number];
export const RUDDER_BROWSER_MCP_TOOL_NAMES = RUDDER_AGENT_V1_MCP_TOOL_NAMES
  .filter((name) => name.startsWith("rudder_browser_"));
export const RUDDER_CORE_MCP_TOOL_NAMES = RUDDER_AGENT_V1_MCP_TOOL_NAMES
  .filter((name) => !name.startsWith("rudder_browser_"));
export type RudderBrowserMcpToolName = (typeof RUDDER_BROWSER_MCP_TOOL_NAMES)[number];
export type RudderCoreMcpToolName = (typeof RUDDER_CORE_MCP_TOOL_NAMES)[number];

export const CUSTOM_INTEGRATION_KINDS = ["custom_api", "mcp_server"] as const;
export type CustomIntegrationKind = (typeof CUSTOM_INTEGRATION_KINDS)[number];

export const CUSTOM_INTEGRATION_SCOPES = ["organization", "agent"] as const;
export type CustomIntegrationScope = (typeof CUSTOM_INTEGRATION_SCOPES)[number];

export const CUSTOM_INTEGRATION_STATUSES = ["active", "disabled", "error", "revoked"] as const;
export type CustomIntegrationStatus = (typeof CUSTOM_INTEGRATION_STATUSES)[number];

export const CUSTOM_INTEGRATION_TOOL_STATUSES = ["active", "disabled", "error", "removed"] as const;
export type CustomIntegrationToolStatus = (typeof CUSTOM_INTEGRATION_TOOL_STATUSES)[number];

export const CUSTOM_INTEGRATION_BINDING_STATUSES = ["active", "revoked"] as const;
export type CustomIntegrationBindingStatus = (typeof CUSTOM_INTEGRATION_BINDING_STATUSES)[number];

export const CUSTOM_INTEGRATION_TOOL_CALL_STATUSES = ["success", "error", "blocked"] as const;
export type CustomIntegrationToolCallStatus = (typeof CUSTOM_INTEGRATION_TOOL_CALL_STATUSES)[number];

export const MCP_CONNECTION_PROVIDERS = ["supabase", "linear", "notion", "github", "custom"] as const;
export type McpConnectionProvider = (typeof MCP_CONNECTION_PROVIDERS)[number];

export const MCP_CONNECTION_TRANSPORTS = ["stdio", "streamable_http", "legacy_manual"] as const;
export type McpConnectionTransport = (typeof MCP_CONNECTION_TRANSPORTS)[number];

export const MCP_CONNECTION_SCOPES = ["organization", "agent"] as const;
export type McpConnectionScope = (typeof MCP_CONNECTION_SCOPES)[number];

export const MCP_CONNECTION_ACCESS_MODES = ["provider_default", "read_only", "read_write"] as const;
export type McpConnectionAccessMode = (typeof MCP_CONNECTION_ACCESS_MODES)[number];

export const MCP_AGENT_ACCESS_MODES = [
  "none",
  "read_only",
  "read_write",
  "provider_granted",
  "full",
] as const;
export type McpAgentAccessMode = (typeof MCP_AGENT_ACCESS_MODES)[number];

export const MCP_CONNECTION_CANONICAL_STATES = ["canonical", "superseded"] as const;
export type McpConnectionCanonicalState = (typeof MCP_CONNECTION_CANONICAL_STATES)[number];

export const MCP_PROVIDER_SCOPE_MODES = ["account", "workspace", "legacy_project"] as const;
export type McpProviderScopeMode = (typeof MCP_PROVIDER_SCOPE_MODES)[number];

export const MCP_PROVIDER_CREDENTIAL_MODES = ["oauth", "pat", "custom"] as const;
export type McpProviderCredentialMode = (typeof MCP_PROVIDER_CREDENTIAL_MODES)[number];

export const MCP_PROVIDER_ORGANIZATION_STATES = [
  "not_connected",
  "connecting",
  "connected",
  "needs_attention",
  "disconnected",
] as const;
export type McpProviderOrganizationState = (typeof MCP_PROVIDER_ORGANIZATION_STATES)[number];

export const MCP_TOOL_CAPABILITY_CLASSES = [
  "read",
  "normal_write",
  "destructive",
  "admin_or_billing",
  "unknown",
] as const;
export type McpToolCapabilityClass = (typeof MCP_TOOL_CAPABILITY_CLASSES)[number];

export const MCP_CONNECTION_STATUSES = [
  "draft",
  "authorizing",
  "selecting_scope",
  "active",
  "needs_reauth",
  "disabled",
  "revoked",
  "error",
] as const;
export type McpConnectionStatus = (typeof MCP_CONNECTION_STATUSES)[number];

export const MCP_OAUTH_GRANT_STATUSES = ["active", "needs_reauth", "revoked", "error"] as const;
export type McpOAuthGrantStatus = (typeof MCP_OAUTH_GRANT_STATUSES)[number];

export const MCP_OAUTH_SESSION_STATUSES = ["authorizing", "consumed", "expired", "error"] as const;
export type McpOAuthSessionStatus = (typeof MCP_OAUTH_SESSION_STATUSES)[number];

export const MCP_AGENT_BINDING_STATUSES = ["active", "disabled", "revoked"] as const;
export type McpAgentBindingStatus = (typeof MCP_AGENT_BINDING_STATUSES)[number];

export const MCP_OAUTH_SESSION_TTL_MS = 10 * 60 * 1000;

export const MCP_PROVIDER_CATALOG = [
  {
    id: "supabase",
    label: "Supabase",
    curated: true,
    requiresOAuth: true,
    credentialMode: "oauth",
    requiresScopeSelection: false,
    scopeLabel: "Account",
    transports: ["streamable_http"],
    accessModes: ["read_only", "read_write"],
    defaultAccessMode: "read_write",
  },
  {
    id: "linear",
    label: "Linear",
    curated: true,
    requiresOAuth: true,
    credentialMode: "oauth",
    requiresScopeSelection: false,
    scopeLabel: "Workspace",
    transports: ["streamable_http"],
    accessModes: ["read_only", "read_write"],
    defaultAccessMode: "read_write",
  },
  {
    id: "notion",
    label: "Notion",
    curated: true,
    requiresOAuth: true,
    credentialMode: "oauth",
    requiresScopeSelection: false,
    scopeLabel: "Workspace",
    transports: ["streamable_http"],
    accessModes: ["provider_default"],
    defaultAccessMode: "provider_default",
  },
  {
    id: "github",
    label: "GitHub",
    curated: true,
    requiresOAuth: false,
    credentialMode: "pat",
    requiresScopeSelection: false,
    scopeLabel: "Account",
    transports: ["streamable_http"],
    accessModes: ["read_only", "read_write"],
    defaultAccessMode: "read_only",
  },
  {
    id: "custom",
    label: "Custom MCP",
    curated: false,
    requiresOAuth: false,
    credentialMode: "custom",
    requiresScopeSelection: false,
    scopeLabel: "Server",
    transports: ["stdio", "streamable_http"],
    accessModes: ["provider_default", "read_only", "read_write"],
    defaultAccessMode: "provider_default",
  },
] as const;

export const CALENDAR_SOURCE_TYPES = ["rudder_local", "google_calendar", "agent_work", "system"] as const;
export type CalendarSourceType = (typeof CALENDAR_SOURCE_TYPES)[number];

export const CALENDAR_OWNER_TYPES = ["user", "agent", "system"] as const;
export type CalendarOwnerType = (typeof CALENDAR_OWNER_TYPES)[number];

export const CALENDAR_VISIBILITIES = ["full", "busy_only", "private"] as const;
export type CalendarVisibility = (typeof CALENDAR_VISIBILITIES)[number];

export const CALENDAR_SOURCE_STATUSES = ["active", "paused", "disconnected", "error"] as const;
export type CalendarSourceStatus = (typeof CALENDAR_SOURCE_STATUSES)[number];

export const CALENDAR_EVENT_KINDS = ["human_event", "agent_work_block", "external_event", "system_event"] as const;
export type CalendarEventKind = (typeof CALENDAR_EVENT_KINDS)[number];

export const CALENDAR_EVENT_STATUSES = ["planned", "in_progress", "actual", "cancelled", "external", "projected"] as const;
export type CalendarEventStatus = (typeof CALENDAR_EVENT_STATUSES)[number];

export const CALENDAR_SOURCE_MODES = ["manual", "derived", "imported"] as const;
export type CalendarSourceMode = (typeof CALENDAR_SOURCE_MODES)[number];

export const CHAT_CONVERSATION_STATUSES = ["active", "resolved", "archived"] as const;
export type ChatConversationStatus = (typeof CHAT_CONVERSATION_STATUSES)[number];

export const CHAT_CONVERSATION_KINDS = ["chat", "side_chat"] as const;
export type ChatConversationKind = (typeof CHAT_CONVERSATION_KINDS)[number];

export const SIDE_CHAT_STATES = ["active", "completed", "expired", "kept"] as const;
export type SideChatState = (typeof SIDE_CHAT_STATES)[number];

export const CHAT_CONVERSATION_MUTABILITIES = ["native_chat", "external_bound_chat", "native_fork_from_external"] as const;
export type ChatConversationMutability = (typeof CHAT_CONVERSATION_MUTABILITIES)[number];

export const CHAT_ISSUE_CREATION_MODES = ["manual_approval", "auto_create"] as const;
export type ChatIssueCreationMode = (typeof CHAT_ISSUE_CREATION_MODES)[number];

export const CHAT_MESSAGE_ROLES = ["user", "assistant", "system"] as const;
export type ChatMessageRole = (typeof CHAT_MESSAGE_ROLES)[number];

export const CHAT_MESSAGE_KINDS = [
  "message",
  "ask_user",
  "issue_proposal",
  "operation_proposal",
  "system_event",
] as const;
export type ChatMessageKind = (typeof CHAT_MESSAGE_KINDS)[number];

export const CHAT_MESSAGE_STATUSES = ["streaming", "completed", "stopped", "failed", "interrupted"] as const;
export type ChatMessageStatus = (typeof CHAT_MESSAGE_STATUSES)[number];

export const CHAT_CONTEXT_ENTITY_TYPES = ["issue", "project", "agent", "goal"] as const;
export type ChatContextEntityType = (typeof CHAT_CONTEXT_ENTITY_TYPES)[number];

export const MESSENGER_THREAD_KINDS = [
  "chat",
  "issues",
  "approvals",
  "failed-runs",
  "budget-alerts",
  "join-requests",
] as const;
export type MessengerThreadKind = (typeof MESSENGER_THREAD_KINDS)[number];

export const MESSENGER_SYSTEM_THREAD_KINDS = [
  "failed-runs",
  "budget-alerts",
  "join-requests",
] as const;
export type MessengerSystemThreadKind = (typeof MESSENGER_SYSTEM_THREAD_KINDS)[number];

export const MESSENGER_FORK_GROUP_DEFAULT_ICON = "🌿" as const;
export const MESSENGER_CUSTOM_GROUP_EMOJI_ICONS = [
  MESSENGER_FORK_GROUP_DEFAULT_ICON,
] as const;

export const GOAL_LEVELS = ["organization", "team", "agent", "task"] as const;
export type GoalLevel = (typeof GOAL_LEVELS)[number];

export const GOAL_STATUSES = ["planned", "active", "achieved", "cancelled"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export const GOAL_OBJECTIVE_MODES = ["target", "maximize", "maintain", "decide"] as const;
export type GoalObjectiveMode = (typeof GOAL_OBJECTIVE_MODES)[number];

export const GOAL_EVALUATOR_KINDS = ["artifact", "metric", "policy", "human"] as const;
export type GoalEvaluatorKind = (typeof GOAL_EVALUATOR_KINDS)[number];

export const GOAL_LIFECYCLES = ["draft", "active", "closed"] as const;
export type GoalLifecycle = (typeof GOAL_LIFECYCLES)[number];

export const GOAL_CLOSE_REASONS = ["evaluated", "cancelled", "superseded"] as const;
export type GoalCloseReason = (typeof GOAL_CLOSE_REASONS)[number];

export const GOAL_CONTINUATION_KINDS = ["commitment", "wait", "decision", "verification"] as const;
export type GoalContinuationKind = (typeof GOAL_CONTINUATION_KINDS)[number];

export const GOAL_ACTIVITY_KINDS = [
  "progress",
  "closeout",
  "evidence",
  "decision_requested",
  "bottleneck",
  "checkpoint",
] as const;
export type GoalActivityKind = (typeof GOAL_ACTIVITY_KINDS)[number];

export const GOAL_START_REQUEST_STATUSES = ["pending", "completed", "failed"] as const;
export type GoalStartRequestStatus = (typeof GOAL_START_REQUEST_STATUSES)[number];

export const GOAL_FEEDBACK_KINDS = ["ordinary", "consequential"] as const;
export type GoalFeedbackKind = (typeof GOAL_FEEDBACK_KINDS)[number];

export const GOAL_CHANGE_PROPOSAL_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "superseded",
  "applied",
] as const;
export type GoalChangeProposalStatus = (typeof GOAL_CHANGE_PROPOSAL_STATUSES)[number];

export const GOAL_RESULT_PROPOSAL_STATUSES = [
  "inconclusive",
  "ready",
  "accepted",
  "rejected",
  "superseded",
] as const;
export type GoalResultProposalStatus = (typeof GOAL_RESULT_PROPOSAL_STATUSES)[number];

export const GOAL_WORKSPACE_FACETS = [
  "agent_advancing",
  "needs_attention",
  "waiting_focus",
  "waiting_external",
  "ready_for_acceptance",
  "closed",
] as const;
export type GoalWorkspaceFacet = (typeof GOAL_WORKSPACE_FACETS)[number];

export const PROJECT_STATUSES = [
  "backlog",
  "planned",
  "in_progress",
  "completed",
  "cancelled",
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const ORGANIZATION_RESOURCE_KINDS = [
  "file",
  "directory",
  "url",
  "connector_object",
] as const;
export type OrganizationResourceKind = (typeof ORGANIZATION_RESOURCE_KINDS)[number];

export const ORGANIZATION_RESOURCE_SOURCE_TYPES = [
  "external",
  "library",
] as const;
export type OrganizationResourceSourceType = (typeof ORGANIZATION_RESOURCE_SOURCE_TYPES)[number];

export const PROJECT_RESOURCE_ATTACHMENT_ROLES = [
  "working_set",
  "reference",
  "tracking",
  "deliverable",
  "background",
] as const;
export type ProjectResourceAttachmentRole = (typeof PROJECT_RESOURCE_ATTACHMENT_ROLES)[number];

export const AUTOMATION_STATUSES = ["active", "paused"] as const;
export type AutomationStatus = (typeof AUTOMATION_STATUSES)[number];

export const AUTOMATION_CONCURRENCY_POLICIES = ["coalesce_if_active", "always_enqueue", "skip_if_active"] as const;
export type AutomationConcurrencyPolicy = (typeof AUTOMATION_CONCURRENCY_POLICIES)[number];

export const AUTOMATION_CATCH_UP_POLICIES = ["skip_missed", "enqueue_missed_with_cap"] as const;
export type AutomationCatchUpPolicy = (typeof AUTOMATION_CATCH_UP_POLICIES)[number];

export const AUTOMATION_OUTPUT_MODES = ["track_issue", "chat_output"] as const;
export type AutomationOutputMode = (typeof AUTOMATION_OUTPUT_MODES)[number];

export const AUTOMATION_TRIGGER_KINDS = ["schedule", "webhook", "api"] as const;
export type AutomationTriggerKind = (typeof AUTOMATION_TRIGGER_KINDS)[number];

export const AUTOMATION_TRIGGER_SIGNING_MODES = ["bearer", "hmac_sha256"] as const;
export type AutomationTriggerSigningMode = (typeof AUTOMATION_TRIGGER_SIGNING_MODES)[number];

export const AUTOMATION_RUN_STATUSES = [
  "received",
  "running",
  "coalesced",
  "skipped",
  "issue_created",
  "completed",
  "failed",
 ] as const;
export type AutomationRunStatus = (typeof AUTOMATION_RUN_STATUSES)[number];

export const AUTOMATION_RUN_SOURCES = ["schedule", "manual", "api", "webhook"] as const;
export type AutomationRunSource = (typeof AUTOMATION_RUN_SOURCES)[number];

export const PAUSE_REASONS = ["manual", "budget", "system"] as const;
export type PauseReason = (typeof PAUSE_REASONS)[number];

export const PROJECT_COLORS = [
  "linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)",
  "linear-gradient(135deg, #7c3aed 0%, #d946ef 100%)",
  "linear-gradient(135deg, #db2777 0%, #f97316 100%)",
  "linear-gradient(135deg, #ef4444 0%, #f59e0b 100%)",
  "linear-gradient(135deg, #f97316 0%, #facc15 100%)",
  "linear-gradient(135deg, #10b981 0%, #84cc16 100%)",
  "linear-gradient(135deg, #059669 0%, #14b8a6 100%)",
  "linear-gradient(135deg, #0d9488 0%, #06b6d4 100%)",
  "linear-gradient(135deg, #0284c7 0%, #2563eb 100%)",
  "linear-gradient(135deg, #2563eb 0%, #4f46e5 100%)",
  "linear-gradient(135deg, #f43f5e 0%, #ec4899 100%)",
  "linear-gradient(135deg, #be123c 0%, #7c2d12 100%)",
  "linear-gradient(135deg, #a16207 0%, #ca8a04 100%)",
  "linear-gradient(135deg, #16a34a 0%, #0f766e 100%)",
  "linear-gradient(135deg, #0891b2 0%, #4338ca 100%)",
  "linear-gradient(135deg, #6d28d9 0%, #be185d 100%)",
  "linear-gradient(135deg, #475569 0%, #0f766e 100%)",
  "linear-gradient(135deg, #334155 0%, #7c3aed 100%)",
] as const;

export const DEFAULT_PROJECT_ICON = "folder" as const;

export const PROJECT_ICONS = [
  "folder",
  "dollar",
  "book",
  "graduation-cap",
  "pencil",
  "pen-tool",
  "braces",
  "terminal",
  "music",
  "popcorn",
  "paintbrush",
  "palette",
  "stethoscope",
  "clover",
  "flower",
  "briefcase",
  "chart",
  "database",
  "dumbbell",
  "notebook",
  "scale",
  "plane",
  "globe",
  "home",
  "tree-palm",
  "heart",
  "gift",
  "wrench",
  "paw-print",
  "flask",
  "brain",
  "code",
  "rocket",
  "target",
  "lightbulb",
  "shield",
  "megaphone",
  "users",
  "calendar",
  "package",
] as const;
export type ProjectIconName = (typeof PROJECT_ICONS)[number];

export const APPROVAL_TYPES = [
  "hire_agent",
  "approve_ceo_strategy",
  "budget_override_required",
  "chat_issue_creation",
  "chat_operation",
  "agent_runtime",
  "goal_change",
] as const;
export type ApprovalType = (typeof APPROVAL_TYPES)[number];

export const APPROVAL_STATUSES = [
  "pending",
  "revision_requested",
  "approved",
  "rejected",
  "cancelled",
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const REQUEST_KINDS = ["approval", "assistance"] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

export const REQUEST_STATUSES = ["open", "resolved", "cancelled", "superseded"] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const ASSISTANCE_REQUEST_RESOLUTIONS = ["answered", "action_completed", "cannot_help"] as const;
export type AssistanceRequestResolution = (typeof ASSISTANCE_REQUEST_RESOLUTIONS)[number];

export const SECRET_PROVIDERS = [
  "local_encrypted",
  "aws_secrets_manager",
  "gcp_secret_manager",
  "vault",
] as const;
export type SecretProvider = (typeof SECRET_PROVIDERS)[number];

export const ORGANIZATION_SECRET_PURPOSES = [
  "user_managed",
  "managed_mcp_connection",
  "managed_mcp_oauth",
] as const;
export type OrganizationSecretPurpose = (typeof ORGANIZATION_SECRET_PURPOSES)[number];

export const STORAGE_PROVIDERS = ["local_disk", "s3"] as const;
export type StorageProvider = (typeof STORAGE_PROVIDERS)[number];

export const BILLING_TYPES = [
  "metered_api",
  "subscription_included",
  "subscription_overage",
  "credits",
  "fixed",
  "unknown",
] as const;
export type BillingType = (typeof BILLING_TYPES)[number];

export const FINANCE_EVENT_KINDS = [
  "inference_charge",
  "platform_fee",
  "credit_purchase",
  "credit_refund",
  "credit_expiry",
  "byok_fee",
  "gateway_overhead",
  "log_storage_charge",
  "logpush_charge",
  "provisioned_capacity_charge",
  "training_charge",
  "custom_model_import_charge",
  "custom_model_storage_charge",
  "manual_adjustment",
] as const;
export type FinanceEventKind = (typeof FINANCE_EVENT_KINDS)[number];

export const FINANCE_DIRECTIONS = ["debit", "credit"] as const;
export type FinanceDirection = (typeof FINANCE_DIRECTIONS)[number];

export const FINANCE_UNITS = [
  "input_token",
  "output_token",
  "cached_input_token",
  "request",
  "credit_usd",
  "credit_unit",
  "model_unit_minute",
  "model_unit_hour",
  "gb_month",
  "train_token",
  "unknown",
] as const;
export type FinanceUnit = (typeof FINANCE_UNITS)[number];

export const BUDGET_SCOPE_TYPES = ["organization", "agent"] as const;
export type BudgetScopeType = (typeof BUDGET_SCOPE_TYPES)[number];

export const BUDGET_METRICS = ["billed_cents"] as const;
export type BudgetMetric = (typeof BUDGET_METRICS)[number];

export const BUDGET_WINDOW_KINDS = ["calendar_month_utc", "lifetime"] as const;
export type BudgetWindowKind = (typeof BUDGET_WINDOW_KINDS)[number];

export const BUDGET_THRESHOLD_TYPES = ["soft", "hard"] as const;
export type BudgetThresholdType = (typeof BUDGET_THRESHOLD_TYPES)[number];

export const BUDGET_INCIDENT_STATUSES = ["open", "resolved", "dismissed"] as const;
export type BudgetIncidentStatus = (typeof BUDGET_INCIDENT_STATUSES)[number];

export const BUDGET_INCIDENT_RESOLUTION_ACTIONS = [
  "keep_paused",
  "raise_budget_and_resume",
] as const;
export type BudgetIncidentResolutionAction = (typeof BUDGET_INCIDENT_RESOLUTION_ACTIONS)[number];

export const HEARTBEAT_INVOCATION_SOURCES = [
  "timer",
  "assignment",
  "review",
  "on_demand",
  "automation",
  "chat",
] as const;
export type HeartbeatInvocationSource = (typeof HEARTBEAT_INVOCATION_SOURCES)[number];

export const WAKEUP_TRIGGER_DETAILS = [
  "manual",
  "ping",
  "callback",
  "system",
  "chat_assistant_reply",
  "chat_assistant_reply_stream",
] as const;
export type WakeupTriggerDetail = (typeof WAKEUP_TRIGGER_DETAILS)[number];

export const WAKEUP_REQUEST_STATUSES = [
  "queued",
  "deferred_issue_execution",
  "deferred_agent_paused",
  "deferred_goal_focus",
  "deferred_goal_blocked",
  "claimed",
  "coalesced",
  "skipped",
  "completed",
  "failed",
  "cancelled",
] as const;
export type WakeupRequestStatus = (typeof WAKEUP_REQUEST_STATUSES)[number];

export const AGENT_ISSUE_CREATION_REQUEST_STATUSES = [
  "queued",
  "running",
  "deferred",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type AgentIssueCreationRequestStatus = (typeof AGENT_ISSUE_CREATION_REQUEST_STATUSES)[number];

export const HEARTBEAT_RUN_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
] as const;
export type HeartbeatRunStatus = (typeof HEARTBEAT_RUN_STATUSES)[number];

export const HEARTBEAT_RUN_EXECUTION_PHASES = ["executing", "waiting_for_network"] as const;
export type HeartbeatRunExecutionPhase = (typeof HEARTBEAT_RUN_EXECUTION_PHASES)[number];

export const LIVE_EVENT_TYPES = [
  "heartbeat.run.queued",
  "heartbeat.run.status",
  "heartbeat.run.event",
  "heartbeat.run.log",
  "agent.status",
  "activity.logged",
  "issue.content_updated",
] as const;
export type LiveEventType = (typeof LIVE_EVENT_TYPES)[number];

export const PRINCIPAL_TYPES = ["user", "agent"] as const;
export type PrincipalType = (typeof PRINCIPAL_TYPES)[number];

export const MEMBERSHIP_STATUSES = ["pending", "active", "suspended"] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

export const INSTANCE_USER_ROLES = ["instance_admin"] as const;
export type InstanceUserRole = (typeof INSTANCE_USER_ROLES)[number];

export const INVITE_TYPES = ["company_join", "bootstrap_ceo"] as const;
export type InviteType = (typeof INVITE_TYPES)[number];

export const INVITE_JOIN_TYPES = ["human", "agent", "both"] as const;
export type InviteJoinType = (typeof INVITE_JOIN_TYPES)[number];

export const JOIN_REQUEST_TYPES = ["human", "agent"] as const;
export type JoinRequestType = (typeof JOIN_REQUEST_TYPES)[number];

export const JOIN_REQUEST_STATUSES = ["pending_approval", "approved", "rejected"] as const;
export type JoinRequestStatus = (typeof JOIN_REQUEST_STATUSES)[number];

export const PERMISSION_KEYS = [
  "agents:create",
  "skills:manage",
  "users:invite",
  "users:manage_permissions",
  "tasks:assign",
  "tasks:assign_scope",
  "joins:approve",
] as const;
export type PermissionKey = (typeof PERMISSION_KEYS)[number];
