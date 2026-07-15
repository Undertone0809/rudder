export type AgentCliCapabilityCategory =
  | "agent"
  | "issue"
  | "project"
  | "automation"
  | "chat"
  | "runs"
  | "approval"
  | "skill"
  | "browser"
  | "user"
  | "library";
export type AgentCliCapabilityContract = "agent-v1" | "compat";

export interface AgentCliCapability {
  id: string;
  command: string;
  category: AgentCliCapabilityCategory;
  description: string;
  mutating: boolean;
  contract: AgentCliCapabilityContract;
  requiresOrgId: boolean;
  requiresAgentId: boolean;
  requiresRunId: boolean;
  attachesRunIdWhenAvailable: boolean;
}

export interface AgentCliCapabilitiesManifestEntry extends AgentCliCapability {
  agentV1: boolean;
}

export interface AgentCliCapabilitiesManifest {
  schema: "rudder.agent-capabilities/v1";
  contract: AgentCliCapabilityContract | "all";
  defaults: {
    orgIdEnvVar: "RUDDER_ORG_ID";
    agentIdEnvVar: "RUDDER_AGENT_ID";
    runIdEnvVar: "RUDDER_RUN_ID";
    jsonErrors: "stderr-error-envelope";
  };
  capabilities: AgentCliCapabilitiesManifestEntry[];
}

export interface AgentV1McpToolManifestEntry extends AgentCliCapabilitiesManifestEntry {
  capabilityId: string;
  name: string;
  inputSchema: {
    type: "object";
    additionalProperties: boolean;
    properties: Record<string, unknown>;
  };
  outputMode: "json";
}

export interface AgentV1McpToolsManifest {
  schema: "rudder.agent-mcp-tools/v1";
  contract: AgentCliCapabilityContract | "all";
  serverName: "rudder-control-plane";
  tools: AgentV1McpToolManifestEntry[];
}

const AGENT_CLI_CAPABILITIES: AgentCliCapability[] = [
  {
    id: "agent.me",
    command: "rudder agent me",
    category: "agent",
    description: "Show the authenticated agent identity, budget, and chain of command.",
    mutating: false,
    contract: "agent-v1",
    requiresOrgId: false,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: false,
  },
  {
    id: "agent.inbox",
    command: "rudder agent inbox",
    category: "agent",
    description: "List the compact assignee and reviewer work inbox for the authenticated agent.",
    mutating: false,
    contract: "agent-v1",
    requiresOrgId: false,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: false,
  },
  {
    id: "agent.capabilities",
    command: "rudder agent capabilities",
    category: "agent",
    description: "List the stable Rudder agent command contract.",
    mutating: false,
    contract: "agent-v1",
    requiresOrgId: false,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: false,
  },
  {
    id: "agent.list",
    command: "rudder agent list --org-id <id>",
    category: "agent",
    description: "List agents for an organization.",
    mutating: false,
    contract: "compat",
    requiresOrgId: true,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: false,
  },
  {
    id: "agent.get",
    command: "rudder agent get <agent-id-or-shortname-or-agt-ref>",
    category: "agent",
    description: "Read one agent by id, shortname, or agt_<uuid-prefix> short ref.",
    mutating: false,
    contract: "compat",
    requiresOrgId: false,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: false,
  },
  {
    id: "agent.update",
    command: "rudder agent update [agent-id] [--title <title>] [--description <text>]",
    category: "agent",
    description:
      "Update an agent's control-plane identity fields; defaults to the authenticated agent.",
    mutating: true,
    contract: "agent-v1",
    requiresOrgId: false,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: true,
  },
  {
    id: "agent.skills.create",
    command: "rudder agent skills create [agent-id] --name <name> [--enable]",
    category: "agent",
    description: "Create an agent-private skill package under AGENT_HOME/skills.",
    mutating: true,
    contract: "agent-v1",
    requiresOrgId: false,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: true,
  },
  {
    id: "agent.skills.enable",
    command: "rudder agent skills enable <agent-id> <selection-ref...>",
    category: "agent",
    description: "Add skill selections to an agent without replacing existing enabled skills.",
    mutating: true,
    contract: "agent-v1",
    requiresOrgId: false,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: true,
  },
  {
    id: "agent.skills.sync",
    command: "rudder agent skills sync <agent-id>",
    category: "agent",
    description: "Sync the desired enabled skill set for an agent.",
    mutating: true,
    contract: "agent-v1",
    requiresOrgId: false,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: true,
  },
  {
    id: "agent.hire",
    command: "rudder agent hire --org-id <id> --payload <json>",
    category: "agent",
    description: "Create a new hire using the canonical hire workflow.",
    mutating: true,
    contract: "compat",
    requiresOrgId: true,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: true,
  },
  {
    id: "agent.config.index",
    command: "rudder agent config index",
    category: "agent",
    description: "Read the installed agent runtime configuration index.",
    mutating: false,
    contract: "compat",
    requiresOrgId: false,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: false,
  },
  {
    id: "agent.config.doc",
    command: "rudder agent config doc <agent-runtime-type>",
    category: "agent",
    description: "Read adapter-specific configuration guidance for one runtime.",
    mutating: false,
    contract: "compat",
    requiresOrgId: false,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: false,
  },
  {
    id: "agent.config.list",
    command: "rudder agent config list --org-id <id>",
    category: "agent",
    description: "List redacted agent configuration snapshots for an organization.",
    mutating: false,
    contract: "compat",
    requiresOrgId: true,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: false,
  },
  {
    id: "agent.config.get",
    command: "rudder agent config get <agent-id-or-shortname>",
    category: "agent",
    description: "Read one redacted agent configuration snapshot by id or shortname.",
    mutating: false,
    contract: "compat",
    requiresOrgId: false,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: false,
  },
  {
    id: "agent.icons",
    command: "rudder agent icons",
    category: "agent",
    description: "List legacy named agent icons for compatibility/debugging; normal create and hire payloads should omit icon.",
    mutating: false,
    contract: "compat",
    requiresOrgId: false,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: false,
  },
  {
    id: "issue.get",
    command: "rudder issue get <issue>",
    category: "issue",
    description: "Read a full issue by UUID or identifier.",
    mutating: false,
    contract: "agent-v1",
    requiresOrgId: false,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: false,
  },
  {
    id: "issue.search",
    command: "rudder issue search <query> [--org-id <id>]",
    category: "issue",
    description: "Search issues with the server-side issue index across title, identifier, description, and comments.",
    mutating: false,
    contract: "agent-v1",
    requiresOrgId: true,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: false,
  },
  {
    id: "issue.context",
    command: "rudder issue context <issue> [--wake-comment-id <comment-id-or-cmt-ref>]",
    category: "issue",
    description: "Read the compact heartbeat context for an issue; wake comments may be addressed by full id or cmt_<uuid-prefix>.",
    mutating: false,
    contract: "agent-v1",
    requiresOrgId: false,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: false,
  },
  {
    id: "issue.checkout",
    command: "rudder issue checkout <issue>",
    category: "issue",
    description: "Atomically checkout an issue for the current or specified agent.",
    mutating: true,
    contract: "agent-v1",
    requiresOrgId: false,
    requiresAgentId: true,
    requiresRunId: false,
    attachesRunIdWhenAvailable: true,
  },
  {
    id: "issue.comment",
    command: "rudder issue comment <issue> --body-file <path> [--image <path>]",
    category: "issue",
    description: "Add a comment to an issue, optionally uploading images and appending Markdown image links.",
    mutating: true,
    contract: "agent-v1",
    requiresOrgId: false,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: true,
  },
  {
    id: "issue.comments.list",
    command: "rudder issue comments list <issue> [--after <comment-id-or-cmt-ref>]",
    category: "issue",
    description: "List issue comments, optionally only newer comments after a full comment id or cmt_<uuid-prefix> with --after.",
    mutating: false,
    contract: "agent-v1",
    requiresOrgId: false,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: false,
  },
  {
    id: "issue.comments.get",
    command: "rudder issue comments get <issue> <comment-id-or-cmt-ref>",
    category: "issue",
    description: "Read one issue comment by full id or cmt_<uuid-prefix> scoped to the issue.",
    mutating: false,
    contract: "agent-v1",
    requiresOrgId: false,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: false,
  },
  {
    id: "issue.update",
    command: "rudder issue update <issue> ... [--comment-file <path>] [--image <path>]",
    category: "issue",
    description: "Apply generic issue updates when workflow commands are not enough, optionally uploading images for the update comment.",
    mutating: true,
    contract: "agent-v1",
    requiresOrgId: false,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: true,
  },
  {
    id: "issue.review",
    command: "rudder issue review <issue> --decision <decision> --comment-file <path>",
    category: "issue",
    description: "Record a structured reviewer decision with a required comment.",
    mutating: true,
    contract: "agent-v1",
    requiresOrgId: false,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: true,
  },
  {
    id: "issue.commit",
    command: "rudder issue commit <issue> --sha <sha> --message <subject>",
    category: "issue",
    description: "Report a code commit created during issue work as structured issue activity.",
    mutating: true,
    contract: "agent-v1",
    requiresOrgId: false,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: true,
  },
  {
    id: "issue.done",
    command: "rudder issue done <issue> --comment-file <path> [--image <path>]",
    category: "issue",
    description: "Mark an issue done with a required completion comment, optionally uploading images.",
    mutating: true,
    contract: "agent-v1",
    requiresOrgId: false,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: true,
  },
  {
    id: "issue.block",
    command: "rudder issue block <issue> --comment-file <path> [--image <path>]",
    category: "issue",
    description: "Mark an issue blocked with a required blocker comment, optionally uploading images.",
    mutating: true,
    contract: "agent-v1",
    requiresOrgId: false,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: true,
  },
  {
    id: "project.list",
    command: "rudder project list --org-id <id>",
    category: "project",
    description: "List projects in an organization.",
    mutating: false,
    contract: "agent-v1",
    requiresOrgId: true,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: false,
  },
  {
    id: "project.get",
    command: "rudder project get <project-id-or-shortname> [--org-id <id>]",
    category: "project",
    description: "Read one project by ID or shortname.",
    mutating: false,
    contract: "agent-v1",
    requiresOrgId: false,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: false,
  },
  {
    id: "project.create",
    command: "rudder project create --org-id <id> --name <name>",
    category: "project",
    description: "Create a project in the organization.",
    mutating: true,
    contract: "agent-v1",
    requiresOrgId: true,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: true,
  },
  {
    id: "project.update",
    command: "rudder project update <project-id-or-shortname> [--org-id <id>]",
    category: "project",
    description: "Update mutable project fields such as name, description, status, goals, lead agent, target date, color, or archivedAt.",
    mutating: true,
    contract: "agent-v1",
    requiresOrgId: false,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: true,
  },
  {
    id: "user.activity",
    command: "rudder user activity --user me --since today --json",
    category: "user",
    description: "Read a user-centered activity ledger with safe excerpts and provenance across chats, issue comments, approval comments, and user actor activity.",
    mutating: false,
    contract: "agent-v1",
    requiresOrgId: true,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: false,
  },
  {
    id: "library.file.list",
    command: "rudder library file list [directory]",
    category: "library",
    description: "List Library files and folders; file rows include `libraryEntryId` when a strong reference can be generated.",
    mutating: false,
    contract: "agent-v1",
    requiresOrgId: true,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: false,
  },
  {
    id: "library.file.get",
    command: "rudder library file get <path>",
    category: "library",
    description: "Fallback read when local filesystem access is unavailable; JSON includes `mentionHref` and `markdownLink`.",
    mutating: false,
    contract: "agent-v1",
    requiresOrgId: true,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: false,
  },
  {
    id: "library.file.ref",
    command: "rudder library file ref <path>",
    category: "library",
    description: "Return the stable Markdown reference for one Library file without printing file content.",
    mutating: false,
    contract: "agent-v1",
    requiresOrgId: true,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: false,
  },
  {
    id: "library.file.link",
    command: "rudder library file link <path>",
    category: "library",
    description: "Compatibility alias for `rudder library file ref <path>`.",
    mutating: false,
    contract: "agent-v1",
    requiresOrgId: true,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: false,
  },
  {
    id: "library.file.put",
    command: "rudder library file put <path> --body-file <path>",
    category: "library",
    description: "Fallback create/update when local filesystem access is unavailable; JSON includes `mentionHref` and `markdownLink`.",
    mutating: true,
    contract: "agent-v1",
    requiresOrgId: true,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: true,
  },
  {
    id: "issue.create",
    command: "rudder issue create --org-id <id> ... [--label-id <id> ...] [--label <name> ...]",
    category: "issue",
    description: "Create a new issue or subtask with the generic issue surface; agent-created issues default to the creating agent when no assignee is supplied.",
    mutating: true,
    contract: "compat",
    requiresOrgId: true,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: true,
  },
  {
    id: "issue.labels.list",
    command: "rudder issue labels list --org-id <id>",
    category: "issue",
    description: "List organization issue labels available for issue creation.",
    mutating: false,
    contract: "compat",
    requiresOrgId: true,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: false,
  },
  {
    id: "approval.get",
    command: "rudder approval get <approval-id>",
    category: "approval",
    description: "Read one approval request.",
    mutating: false,
    contract: "agent-v1",
    requiresOrgId: false,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: false,
  },
  {
    id: "approval.create",
    command: "rudder approval create --org-id <id> --type <type> --payload <json>",
    category: "approval",
    description: "Create a new approval request.",
    mutating: true,
    contract: "compat",
    requiresOrgId: true,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: true,
  },
  {
    id: "approval.issues",
    command: "rudder approval issues <approval-id>",
    category: "approval",
    description: "List the issues linked to an approval.",
    mutating: false,
    contract: "agent-v1",
    requiresOrgId: false,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: false,
  },
  {
    id: "approval.comment",
    command: "rudder approval comment <approval-id> --body-file <path>",
    category: "approval",
    description: "Add a comment to an approval.",
    mutating: true,
    contract: "agent-v1",
    requiresOrgId: false,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: true,
  },
  {
    id: "approval.resubmit",
    command: "rudder approval resubmit <approval-id> [--payload <json>]",
    category: "approval",
    description: "Resubmit a revision-requested approval, optionally with updated payload.",
    mutating: true,
    contract: "compat",
    requiresOrgId: false,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: true,
  },
  {
    id: "skill.list",
    command: "rudder skill list --org-id <id>",
    category: "skill",
    description: "List organization-visible skills.",
    mutating: false,
    contract: "agent-v1",
    requiresOrgId: true,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: false,
  },
  {
    id: "skill.get",
    command: "rudder skill get <skill-id> --org-id <id>",
    category: "skill",
    description: "Read one organization skill detail.",
    mutating: false,
    contract: "agent-v1",
    requiresOrgId: true,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: false,
  },
  {
    id: "skill.file",
    command: "rudder skill file <skill-id> --org-id <id> [--path SKILL.md]",
    category: "skill",
    description: "Read one file from an organization skill package.",
    mutating: false,
    contract: "agent-v1",
    requiresOrgId: true,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: false,
  },
  {
    id: "skill.import",
    command: "rudder skill import --org-id <id> --source <source>",
    category: "skill",
    description: "Import a skill package into the organization skill library.",
    mutating: true,
    contract: "agent-v1",
    requiresOrgId: true,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: true,
  },
  {
    id: "skill.scan-local",
    command: "rudder skill scan-local --org-id <id> [--roots <csv>]",
    category: "skill",
    description: "Scan local roots for skill packages and import new ones.",
    mutating: true,
    contract: "agent-v1",
    requiresOrgId: true,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: true,
  },
  {
    id: "skill.scan-projects",
    command: "rudder skill scan-projects --org-id <id> [--project-ids <csv>] [--workspace-ids <csv>]",
    category: "skill",
    description:
      "Scan the org workspace and any legacy project workspace records for skill packages and import new ones.",
    mutating: true,
    contract: "agent-v1",
    requiresOrgId: true,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: true,
  },
  {
    id: "browser.tabs",
    command: "rudder browser tabs",
    category: "browser",
    description: "List Browser tabs owned by the current Rudder agent run.",
    mutating: false,
    contract: "agent-v1",
    requiresOrgId: true,
    requiresAgentId: true,
    requiresRunId: true,
    attachesRunIdWhenAvailable: false,
  },
  {
    id: "browser.open",
    command: "rudder browser open <url>",
    category: "browser",
    description: "Open a run-owned tab in the Rudder Browser.",
    mutating: true,
    contract: "agent-v1",
    requiresOrgId: true,
    requiresAgentId: true,
    requiresRunId: true,
    attachesRunIdWhenAvailable: true,
  },
  {
    id: "browser.navigate",
    command: "rudder browser navigate <tab-id> <url>",
    category: "browser",
    description: "Navigate a run-owned Rudder Browser tab.",
    mutating: true,
    contract: "agent-v1",
    requiresOrgId: true,
    requiresAgentId: true,
    requiresRunId: true,
    attachesRunIdWhenAvailable: true,
  },
  {
    id: "browser.read",
    command: "rudder browser read <tab-id>",
    category: "browser",
    description: "Read a structured snapshot from a run-owned Rudder Browser tab.",
    mutating: false,
    contract: "agent-v1",
    requiresOrgId: true,
    requiresAgentId: true,
    requiresRunId: true,
    attachesRunIdWhenAvailable: false,
  },
  {
    id: "browser.click",
    command: "rudder browser click <tab-id> <ref>",
    category: "browser",
    description: "Click an element reference returned by Rudder Browser read.",
    mutating: true,
    contract: "agent-v1",
    requiresOrgId: true,
    requiresAgentId: true,
    requiresRunId: true,
    attachesRunIdWhenAvailable: true,
  },
  {
    id: "browser.type",
    command: "rudder browser type <tab-id> <ref> --text <text>",
    category: "browser",
    description: "Type into an element reference in a run-owned Rudder Browser tab.",
    mutating: true,
    contract: "agent-v1",
    requiresOrgId: true,
    requiresAgentId: true,
    requiresRunId: true,
    attachesRunIdWhenAvailable: true,
  },
  {
    id: "browser.screenshot",
    command: "rudder browser screenshot <tab-id>",
    category: "browser",
    description: "Capture a screenshot of a run-owned Rudder Browser tab.",
    mutating: false,
    contract: "agent-v1",
    requiresOrgId: true,
    requiresAgentId: true,
    requiresRunId: true,
    attachesRunIdWhenAvailable: false,
  },
  {
    id: "browser.close",
    command: "rudder browser close <tab-id>",
    category: "browser",
    description: "Close a run-owned Rudder Browser tab.",
    mutating: true,
    contract: "agent-v1",
    requiresOrgId: true,
    requiresAgentId: true,
    requiresRunId: true,
    attachesRunIdWhenAvailable: true,
  },
  {
    id: "automation.list",
    command: "rudder automation list --org-id <id>",
    category: "automation",
    description: "List automations for an organization with compact local filters.",
    mutating: false,
    contract: "agent-v1",
    requiresOrgId: true,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: false,
  },
  {
    id: "automation.get",
    command: "rudder automation get <automation-id>",
    category: "automation",
    description: "Read one automation detail including triggers and recent runs.",
    mutating: false,
    contract: "agent-v1",
    requiresOrgId: false,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: false,
  },
  {
    id: "automation.runs",
    command: "rudder automation runs <automation-id>",
    category: "automation",
    description: "List recent runs for one automation.",
    mutating: false,
    contract: "agent-v1",
    requiresOrgId: false,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: false,
  },
  {
    id: "automation.triggers.list",
    command: "rudder automation triggers list <automation-id>",
    category: "automation",
    description: "List triggers configured for one automation.",
    mutating: false,
    contract: "agent-v1",
    requiresOrgId: false,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: false,
  },
  {
    id: "automation.triggers.create",
    command: "rudder automation triggers create <automation-id> --kind <kind>",
    category: "automation",
    description: "Create a schedule, webhook, or API trigger through the governed automation API.",
    mutating: true,
    contract: "agent-v1",
    requiresOrgId: false,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: true,
  },
  {
    id: "automation.triggers.update",
    command: "rudder automation triggers update <trigger-id>",
    category: "automation",
    description: "Update an automation trigger through the governed automation API.",
    mutating: true,
    contract: "agent-v1",
    requiresOrgId: false,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: true,
  },
  {
    id: "automation.triggers.delete",
    command: "rudder automation triggers delete <trigger-id>",
    category: "automation",
    description: "Delete an automation trigger through the governed automation API.",
    mutating: true,
    contract: "agent-v1",
    requiresOrgId: false,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: true,
  },
  {
    id: "automation.triggers.rotate-secret",
    command: "rudder automation triggers rotate-secret <trigger-id>",
    category: "automation",
    description: "Rotate an automation webhook trigger secret through the governed automation API.",
    mutating: true,
    contract: "agent-v1",
    requiresOrgId: false,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: true,
  },
  {
    id: "automation.create",
    command: "rudder automation create --org-id <id> --title <title> --assignee-agent-id <id>",
    category: "automation",
    description: "Create an automation through the governed automation API.",
    mutating: true,
    contract: "agent-v1",
    requiresOrgId: true,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: true,
  },
  {
    id: "automation.update",
    command: "rudder automation update <automation-id>",
    category: "automation",
    description: "Update automation fields through the governed automation API.",
    mutating: true,
    contract: "agent-v1",
    requiresOrgId: false,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: true,
  },
  {
    id: "automation.enable",
    command: "rudder automation enable <automation-id>",
    category: "automation",
    description: "Enable an automation by setting status to active.",
    mutating: true,
    contract: "agent-v1",
    requiresOrgId: false,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: true,
  },
  {
    id: "automation.disable",
    command: "rudder automation disable <automation-id>",
    category: "automation",
    description: "Disable an automation by setting status to paused.",
    mutating: true,
    contract: "agent-v1",
    requiresOrgId: false,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: true,
  },
  {
    id: "automation.run",
    command: "rudder automation run <automation-id>",
    category: "automation",
    description: "Trigger a manual automation run.",
    mutating: true,
    contract: "agent-v1",
    requiresOrgId: false,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: true,
  },
  {
    id: "chat.list",
    command: "rudder chat list --org-id <id>",
    category: "chat",
    description: "List chat conversations without dumping full message history.",
    mutating: false,
    contract: "agent-v1",
    requiresOrgId: true,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: false,
  },
  {
    id: "chat.search",
    command: "rudder chat search <query> --org-id <id>",
    category: "chat",
    description: "Search chats with bounded snippets and optional scope filtering.",
    mutating: false,
    contract: "agent-v1",
    requiresOrgId: true,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: false,
  },
  {
    id: "chat.get",
    command: "rudder chat get <chat-id>",
    category: "chat",
    description: "Read one chat conversation record.",
    mutating: false,
    contract: "agent-v1",
    requiresOrgId: false,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: false,
  },
  {
    id: "chat.messages",
    command: "rudder chat messages <chat-id> [--limit <n>] [--cursor <cursor>] [--include-transcript]",
    category: "chat",
    description: "Read bounded chat messages with page cursors; transcript output is omitted unless requested.",
    mutating: false,
    contract: "agent-v1",
    requiresOrgId: false,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: false,
  },
  {
    id: "chat.transcript",
    command: "rudder chat transcript <chat-id> [--limit <n>] [--cursor <cursor>] [--max-output-chars <n>]",
    category: "chat",
    description: "Read paginated chat messages with assistant transcript entries clipped in human output.",
    mutating: false,
    contract: "agent-v1",
    requiresOrgId: false,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: false,
  },
  {
    id: "chat.read",
    command: "rudder chat read <chat-id> [--turn-limit <n>] [--cursor <cursor>] [--include-output]",
    category: "chat",
    description: "Read a bounded recent-message snapshot for one chat with page cursors.",
    mutating: false,
    contract: "agent-v1",
    requiresOrgId: false,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: false,
  },
  {
    id: "chat.create",
    command: "rudder chat create --org-id <id>",
    category: "chat",
    description: "Create a chat conversation.",
    mutating: true,
    contract: "agent-v1",
    requiresOrgId: true,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: true,
  },
  {
    id: "chat.send",
    command: "rudder chat send <chat-id> --body <text>",
    category: "chat",
    description: "Send an agent-authored message directly to the operator in a chat.",
    mutating: true,
    contract: "agent-v1",
    requiresOrgId: false,
    requiresAgentId: true,
    requiresRunId: false,
    attachesRunIdWhenAvailable: true,
  },
  {
    id: "chat.archive",
    command: "rudder chat archive <chat-id>",
    category: "chat",
    description: "Archive a chat conversation without deleting it.",
    mutating: true,
    contract: "agent-v1",
    requiresOrgId: false,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: true,
  },
  {
    id: "runs.list",
    command: "rudder runs list --org-id <id> [--used-skill <skill>] [--loaded-skill <skill>] [--cursor <cursor>] [--full]",
    category: "runs",
    description: "List lightweight run summaries with stable pagination and filters; use --full only for legacy full-row compatibility.",
    mutating: false,
    contract: "agent-v1",
    requiresOrgId: true,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: false,
  },
  {
    id: "runs.by-skill",
    command: "rudder runs by-skill <skill> --org-id <id> [--evidence <used-or-loaded>] [--cursor <cursor>] [--full]",
    category: "runs",
    description: "Build a paginated skill evidence packet from lightweight run summaries; use --full only for legacy full-row compatibility.",
    mutating: false,
    contract: "agent-v1",
    requiresOrgId: true,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: false,
  },
  {
    id: "runs.get",
    command: "rudder runs get <run-id> [--full]",
    category: "runs",
    description: "Read one bounded run summary; use --full only from a direct trusted CLI for raw detail.",
    mutating: false,
    contract: "agent-v1",
    requiresOrgId: false,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: false,
  },
  {
    id: "runs.events",
    command: "rudder runs events <run-id> [--cursor <cursor>] [--after-seq <n>] [--limit <n>] [--full]",
    category: "runs",
    description: "List a bounded page of persisted run events with a lossless opaque cursor and clipped payload previews.",
    mutating: false,
    contract: "agent-v1",
    requiresOrgId: false,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: false,
  },
  {
    id: "runs.log",
    command: "rudder runs log <run-id> [--offset <bytes>] [--limit-bytes <n>]",
    category: "runs",
    description: "Read a bounded byte range of stored run log content.",
    mutating: false,
    contract: "agent-v1",
    requiresOrgId: false,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: false,
  },
  {
    id: "runs.transcript",
    command: "rudder runs transcript <run-id> [--turn-limit <n>] [--cursor <cursor>] [--include-output] [--full]",
    category: "runs",
    description: "Read a compact server-normalized transcript; --json changes encoding only and --full is direct-CLI-only raw access.",
    mutating: false,
    contract: "agent-v1",
    requiresOrgId: false,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: false,
  },
  {
    id: "runs.errors",
    command: "rudder runs errors <run-id>",
    category: "runs",
    description: "List failed tool calls, stderr, runtime failures, and jump-to-context commands.",
    mutating: false,
    contract: "agent-v1",
    requiresOrgId: false,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: false,
  },
  {
    id: "runs.cancel",
    command: "rudder runs cancel <run-id>",
    category: "runs",
    description: "Cancel a heartbeat run through the governed server route.",
    mutating: true,
    contract: "agent-v1",
    requiresOrgId: false,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: true,
  },
  {
    id: "runs.retry",
    command: "rudder runs retry <run-id>",
    category: "runs",
    description: "Retry a failed, timed out, or cancelled run through the governed server route.",
    mutating: true,
    contract: "agent-v1",
    requiresOrgId: false,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: true,
  },
];

const CATEGORY_TITLES: Record<AgentCliCapabilityCategory, string> = {
  agent: "Agent",
  issue: "Issue",
  project: "Project",
  automation: "Automation",
  chat: "Chat",
  runs: "Runs",
  approval: "Approval",
  skill: "Skill",
  browser: "Browser",
  user: "User",
  library: "Library",
};

export function getAgentCliCapabilities(): AgentCliCapability[] {
  return AGENT_CLI_CAPABILITIES.map((entry) => ({ ...entry }));
}

export function getAgentCliCapabilityById(id: string): AgentCliCapability {
  const entry = AGENT_CLI_CAPABILITIES.find((capability) => capability.id === id);
  if (!entry) {
    throw new Error(`Unknown agent CLI capability: ${id}`);
  }
  return entry;
}

export function buildAgentCliCapabilitiesManifest(
  contract: AgentCliCapabilityContract | "all" = "agent-v1",
): AgentCliCapabilitiesManifest {
  const capabilities = AGENT_CLI_CAPABILITIES
    .filter((entry) => contract === "all" || entry.contract === contract)
    .map((entry) => ({
      ...entry,
      agentV1: entry.contract === "agent-v1",
    }));

  return {
    schema: "rudder.agent-capabilities/v1",
    contract,
    defaults: {
      orgIdEnvVar: "RUDDER_ORG_ID",
      agentIdEnvVar: "RUDDER_AGENT_ID",
      runIdEnvVar: "RUDDER_RUN_ID",
      jsonErrors: "stderr-error-envelope",
    },
    capabilities,
  };
}

export function agentCliCapabilityIdToMcpToolName(id: string): string {
  return `rudder_${id.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`;
}

function mcpString(description: string): Record<string, unknown> {
  return { type: "string", description };
}

function mcpBoolean(description: string): Record<string, unknown> {
  return { type: "boolean", description };
}

function mcpNumber(description: string): Record<string, unknown> {
  return { type: "number", description };
}

function mcpStringArray(description: string): Record<string, unknown> {
  return { type: "array", items: { type: "string" }, description };
}

function mcpInputSchemaForCapability(id: string): AgentV1McpToolManifestEntry["inputSchema"] {
  const properties: Record<string, unknown> = {};
  const add = (key: string, value: Record<string, unknown>) => {
    properties[key] = value;
  };

  if (id.startsWith("runs.")) {
    const addString = (key: string, description: string) => add(key, mcpString(description));
    const addNumber = (key: string, description: string) => add(key, mcpNumber(description));
    const addBoolean = (key: string, description: string) => add(key, mcpBoolean(description));
    switch (id) {
      case "runs.list":
        addString("updatedAfter", "Only runs updated after this timestamp.");
        addString("runIdPrefix", "Run id prefix filter.");
        addString("relatedAgentId", "Agent id filter.");
        addString("status", "Run status filter.");
        addString("runtime", "Runtime type filter.");
        addString("issueId", "Linked issue id filter.");
        addString("usedSkill", "Used skill filter.");
        addString("loadedSkill", "Loaded skill filter.");
        addString("createdBefore", "Only runs created before this timestamp.");
        addString("cursor", "Stable summary cursor.");
        addNumber("limit", "Summary page size, capped by the server.");
        break;
      case "runs.by-skill":
        addString("skill", "Skill key or display name.");
        addString("evidence", "Evidence type: used or loaded.");
        addString("relatedAgentId", "Agent id filter.");
        addString("status", "Run status filter.");
        addString("runtime", "Runtime type filter.");
        addString("issueId", "Linked issue id filter.");
        addString("createdBefore", "Only runs created before this timestamp.");
        addString("cursor", "Stable summary cursor.");
        addNumber("limit", "Summary page size, capped by the server.");
        break;
      case "runs.events":
        addString("run", "Run id or short run id.");
        addString("cursor", "Opaque total-order event cursor.");
        addNumber("afterSeq", "Legacy sequence-only cursor.");
        addNumber("limit", "Event page size, capped by the server.");
        addNumber("maxChars", "Maximum payload preview characters per event.");
        break;
      case "runs.log":
        addString("run", "Run id or short run id.");
        addNumber("maxChars", "Maximum log characters for display.");
        addNumber("offset", "Byte offset for the ranged read.");
        addNumber("limitBytes", "Maximum bytes for the ranged read.");
        break;
      case "runs.transcript":
        addString("run", "Run id or short run id.");
        addBoolean("errorsOnly", "Return only error rows.");
        addString("aroundError", "Transcript error step id.");
        addNumber("contextTurns", "Turns around the selected error.");
        addString("cursor", "Stable transcript cursor.");
        addNumber("turnLimit", "Maximum turns to return.");
        addBoolean("chronological", "Return oldest-first rows.");
        addBoolean("narrative", "Use narrative row formatting.");
        addNumber("maxChars", "Maximum output characters per row.");
        addBoolean("includeOutput", "Include clipped row output.");
        break;
      case "runs.errors":
        addString("run", "Run id or short run id.");
        addString("cursor", "Error page cursor.");
        addNumber("maxChars", "Maximum output characters per error.");
        break;
      default:
        addString("run", "Run id or short run id.");
        break;
    }
    return {
      type: "object",
      additionalProperties: false,
      properties,
    };
  }

  if (id.startsWith("issue.")) {
    add("issue", mcpString("Issue UUID, identifier, or short reference."));
    add("body", mcpString("Direct Markdown body for issue comments or close-out notes."));
    add("comment", mcpString("Direct Markdown review, blocker, or completion comment."));
    add("images", { type: "array", items: { type: "string" }, description: "Local image paths to attach when supported." });
  }
  if (id.startsWith("project.")) add("project", mcpString("Project UUID or shortname."));
  if (id.startsWith("library.file.")) {
    add("path", mcpString("Library-relative file or directory path."));
    if (id === "library.file.list") {
      add("directory", mcpString("Library-relative directory path. Defaults to the run's project Library path when available."));
    }
    add("body", mcpString("Direct file content for put operations."));
  }
  if (id.startsWith("approval.")) {
    add("approval", mcpString("Approval UUID or short reference."));
    add("body", mcpString("Direct Markdown approval comment body."));
  }
  if (id.startsWith("skill.")) {
    add("skill", mcpString("Organization skill id."));
    add("path", mcpString("Skill package file path, such as SKILL.md."));
  }
  if (id.startsWith("browser.")) {
    add("url", mcpString("HTTP or HTTPS URL."));
    add("tabId", mcpString("Run-owned Rudder Browser tab id."));
    add("ref", mcpString("Element reference returned by rudder_browser_read."));
    add("text", mcpString("Text to enter into the referenced element."));
  }
  if (id.startsWith("automation.")) {
    add("automation", mcpString("Automation id."));
    add("trigger", mcpString("Automation trigger id."));
    add("payload", { type: ["object", "string"], description: "JSON payload object or JSON string." });
  }
  if (id.startsWith("chat.")) {
    add("chat", mcpString("Chat conversation id."));
    add("body", mcpString("Agent-authored chat message body."));
  }
  if (id.startsWith("agent.skills.")) {
    add("selectionRefs", { type: "array", items: { type: "string" }, description: "Skill selection refs." });
    add("skills", { type: "array", items: { type: "string" }, description: "Skill selection refs alias." });
    add("desiredSkills", mcpString("Comma-separated desired skill refs for sync."));
  }

  for (const [key, description] of Object.entries({
    query: "Search query.",
    decision: "Structured review decision.",
    title: "Title.",
    name: "Name.",
    description: "Description or summary text.",
    status: "Status filter or new status.",
    cursor: "Pagination cursor.",
    source: "Source path or source label.",
    kind: "Trigger kind.",
    label: "Trigger label.",
    skill: "Skill key, id, or display name.",
    slug: "Slug.",
    markdown: "Direct Markdown content.",
    role: "Agent role.",
    reportsTo: "Manager or reporting agent reference.",
    capabilities: "Agent capability summary.",
    wakeCommentId: "Issue comment id that triggered the wake.",
    expectedStatuses: "Comma-separated checkout precondition statuses.",
    after: "Pagination anchor or lower bound.",
    order: "Sort order.",
    priority: "Issue or automation priority.",
    assigneeAgentId: "Target assignee agent id or reference.",
    projectId: "Project id or reference.",
    goalId: "Goal id or reference.",
    parentId: "Parent issue id or reference.",
    parentIssueId: "Parent issue id or reference.",
    requestDepth: "Requested issue depth.",
    billingCode: "Billing code.",
    hiddenAt: "Hidden timestamp.",
    archivedAt: "Archived timestamp.",
    targetDate: "Target date.",
    color: "Display color.",
    scope: "Search or visibility scope.",
    sha: "Git commit SHA.",
    message: "Commit or status message.",
    branch: "Git branch name.",
    repoPath: "Repository path.",
    workspacePath: "Workspace path.",
    relatedAgentId: "Agent id used as a filter or related principal.",
    leadAgentId: "Lead agent id or reference.",
    approvalId: "Approval id or short approval id alias.",
    automationId: "Automation id alias.",
    chatId: "Chat conversation id alias.",
    commentId: "Issue comment id alias.",
    skillId: "Skill id alias.",
    user: "User id, reference, or self.",
    since: "Activity start timestamp.",
    until: "Activity end timestamp.",
    include: "Comma-separated optional data sections.",
    content: "Direct content alias for body.",
    roots: "Comma-separated local roots.",
    projectIds: "Comma-separated project ids.",
    workspaceIds: "Comma-separated workspace ids.",
    cronExpression: "Cron expression.",
    timezone: "Timezone.",
    signingMode: "Webhook signing mode.",
    replayWindowSec: "Webhook replay window in seconds.",
    instructions: "Automation instructions.",
    outputMode: "Automation output mode.",
    concurrencyPolicy: "Automation concurrency policy.",
    catchUpPolicy: "Automation catch-up policy.",
    triggerId: "Automation trigger id.",
    idempotencyKey: "Idempotency key.",
    summary: "Chat summary.",
    preferredAgentId: "Preferred responding agent id or reference.",
    issueCreationMode: "Chat issue creation mode.",
    editUserMessageId: "User message id to edit.",
    updatedAfter: "Run updated-after timestamp.",
    runIdPrefix: "Run id prefix filter.",
    runtime: "Runtime type filter.",
    issueId: "Issue id filter.",
    usedSkill: "Used skill filter.",
    loadedSkill: "Loaded skill filter.",
    createdBefore: "Created-before timestamp.",
    evidence: "Skill evidence type.",
    aroundError: "Transcript error step id.",
    maxOutputChars: "Maximum output characters.",
  })) {
    add(key, mcpString(description));
  }
  for (const [key, description] of Object.entries({
    limit: "Page size or result limit.",
    count: "Count represented by a report.",
    turnLimit: "Maximum turns to return.",
    contextTurns: "Number of context turns.",
    maxChars: "Maximum characters.",
    snippetChars: "Maximum snippet characters.",
    afterSeq: "Return events after this sequence number.",
    offset: "Byte offset for ranged reads.",
    limitBytes: "Maximum bytes for ranged reads.",
  })) {
    add(key, mcpNumber(description));
  }
  for (const [key, description] of Object.entries({
    selectionRefs: "Skill selection refs.",
    selections: "Skill selection refs alias.",
    skills: "Skill selection refs alias.",
    images: "Local image paths to attach when supported.",
    goalIds: "Goal ids.",
  })) {
    add(key, mcpStringArray(description));
  }
  for (const key of ["clearTitle", "clearCapabilities", "clearDescription", "clearReportsTo", "enable", "enabled", "disabled", "reopen", "planMode", "includeTranscript", "includeOutput", "includeOutputs", "notifyOnIssueCreated", "errorsOnly", "chronological", "narrative", "submit", "full"]) {
    add(key, mcpBoolean(`Boolean option ${key}.`));
  }

  return {
    type: "object",
    additionalProperties: false,
    properties,
  };
}

export function buildAgentV1McpToolsManifest(
  contract: AgentCliCapabilityContract | "all" = "agent-v1",
  options: { browserEnabled?: boolean } = {},
): AgentV1McpToolsManifest {
  const capabilities = buildAgentCliCapabilitiesManifest(contract).capabilities
    .filter((entry) => options.browserEnabled !== false || entry.category !== "browser");

  return {
    schema: "rudder.agent-mcp-tools/v1",
    contract,
    serverName: "rudder-control-plane",
    tools: capabilities.map((entry) => ({
      ...entry,
      capabilityId: entry.id,
      name: agentCliCapabilityIdToMcpToolName(entry.id),
      inputSchema: mcpInputSchemaForCapability(entry.id),
      outputMode: "json",
    })),
  };
}

export function renderAgentCliReferenceMarkdown(): string {
  const manifest = buildAgentCliCapabilitiesManifest("agent-v1");
  const mcpManifest = buildAgentV1McpToolsManifest("agent-v1");
  const mcpByCapability = new Map(mcpManifest.tools.map((tool) => [tool.capabilityId, tool]));
  const lines: string[] = [
    "# Rudder Agent CLI Reference",
    "",
    "Stable compatibility contract for agents using the bundled `rudder` skill. Prefer first-party Rudder MCP tools when the runtime exposes them; use these CLI commands as fallback when MCP is unavailable or a Rudder MCP tool returns a transport/configuration error.",
    "",
    "## Chat And Issue Surface Boundary",
    "",
    "Chat and issues are parallel ways to advance real tasks. Chat supports",
    "conversation-driven execution; issues add explicit ownership, status, priority,",
    "dependencies, and review structure. Do not create or require an issue merely",
    "because Chat work is executable, long-running, reviewable, or durable. Use the",
    "issue checkout and close-out commands below only for issue-scoped work, or when",
    "operator intent or team governance requires that structure.",
    "",
    "## Defaults",
    "",
    "- First-party MCP tools use the stable `rudder_<capability_id>` naming convention, for example `rudder_issue_checkout` for `issue.checkout`.",
    "- All commands support `--json`.",
    "- CLI output renders IDs as short IDs by default; `rudder runs ...` commands accept short run IDs. Add `--full-ids` only when a debugging or compatibility workflow needs raw UUIDs.",
    "- `--org-id` defaults to `RUDDER_ORG_ID` when relevant.",
    "- `--run-id` defaults to `RUDDER_RUN_ID` and is attached to mutating requests when available.",
    "- `issue checkout` defaults `--agent-id` from `RUDDER_AGENT_ID`.",
    "",
    "## JSON Output Contract",
    "",
    "`rudder ... --json` commands must write valid JSON to stdout on success. ID fields in CLI JSON use short display IDs by default; pass `--full-ids` to preserve raw UUIDs. Short run IDs returned by CLI output can be passed back into `rudder runs get`, `events`, `log`, `transcript`, `errors`, `cancel`, and `retry`. If a command cannot produce the requested JSON, it must exit nonzero and write a diagnostic error to stderr. An exit-0 command with empty stdout is a CLI/runtime defect, not a valid empty result.",
    "",
    "Direct API fallback is allowed for heartbeat close-out only when a required CLI command fails diagnostically or returns exit 0 with empty stdout. When using fallback, note the affected command and reason in the issue comment or run notes so the CLI path can be fixed.",
    "",
    "## Agent V1 Commands",
    "",
    "| MCP Tool | CLI Fallback | Description | Mutating | Org | Agent | Run ID |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];

  for (const capability of manifest.capabilities) {
    const tool = mcpByCapability.get(capability.id);
    lines.push(
      `| \`${tool?.name ?? agentCliCapabilityIdToMcpToolName(capability.id)}\` | \`${capability.command}\` | ${capability.description} | ${capability.mutating ? "yes" : "no"} | ${
        capability.requiresOrgId ? "required" : "no"
      } | ${capability.requiresAgentId ? "required" : "no"} | ${
        capability.requiresRunId ? "required" : capability.attachesRunIdWhenAvailable ? "attached when available" : "no"
      } |`,
    );
  }

  lines.push(
    "",
    "## Issue Close-Out Signals",
    "",
    "Before a successful `todo` or `in_progress` issue run exits, leave one close-out signal with the command that matches the outcome:",
    "",
    "- progress remains: `rudder issue comment <issue> --body-file <path> [--image <path>]`",
    "- work is complete: `rudder issue done <issue> --comment-file <path> [--image <path>]`",
    "- work is blocked: `rudder issue block <issue> --comment-file <path> [--image <path>]`",
    "- ownership changes: add an explicit handoff comment before or with the assignee update",
    "",
    "If a comment wakes you on an issue not assigned to you, including user-owned or",
    "unassigned issues, treat that comment as the scope of the wake unless it",
    "explicitly asks you to implement, modify files, close the issue, or take",
    "ownership. Questions should get answers, corrections should get acknowledgment",
    "or explanation, and narrow requests should not become permission to finish the",
    "whole issue.",
    "",
    "If an issue has a reviewer, moving it to `blocked` also routes reviewer work: the reviewer should confirm the blocker, request changes, approve, or keep explicit follow-up open with `rudder issue review`.",
    "",
    "Issue comment and close-out commands accept comment bodies only from files or stdin. For any multiline Markdown, command names, code spans, code blocks, test summaries, or screenshot evidence, write the comment to a temporary Markdown file and pass `--body-file <path>` or `--comment-file <path>`, or pass `-` to read the body from stdin.",
    "",
    "Issue comment responses include `shortRef` when available. `rudder issue comments get <issue> <comment-id-or-cmt-ref>` accepts a full comment UUID or `cmt_<uuid-prefix>`, and `rudder issue comments list <issue> --after <comment-id-or-cmt-ref>` accepts the same forms for the pagination anchor. Use the full UUID when a short ref is ambiguous within the issue.",
    "",
    "`--image` may be repeated. The CLI uploads each local PNG/JPEG/WebP/GIF as an issue attachment and appends Markdown image links to the comment text before sending it.",
    "",
    "If your issue comment cites a screenshot path or visual validation artifact, attach that file with `--image <path>` instead of leaving only the local path in the text.",
    "",
    "If `RUDDER_WAKE_REASON=issue_passive_followup`, the run is issue follow-up for the same issue. Inspect current issue state first, then leave a progress comment, completion, blocker, or explicit handoff.",
    "",
    "## Renderable Library References",
    "",
    "Agents should not hand-write `library-entry://...` URLs. Local trusted agents",
    "should create and update durable project files directly under",
    "`$RUDDER_PROJECT_LIBRARY_ROOT` with normal filesystem tools when the run has",
    "project context. When there is no project context, write durable generated",
    "chat/work artifacts under",
    "`$RUDDER_ORG_WORKSPACE_ROOT/artifacts/YYYY-MM-DD/<conversation-title>/<relative-file>`",
    "and reference the Library-relative product path",
    "`artifacts/YYYY-MM-DD/<conversation-title>/<relative-file>`. After creating,",
    "updating, or reading a durable Library file, use `rudder library file ref` to",
    "get the CLI-returned `markdownLink` for issue comments, review comments,",
    "blocker notes, done comments, and chat replies.",
    "",
    "```bash",
    "printf '%s\\n' \"<markdown body>\" > \"$RUDDER_PROJECT_LIBRARY_ROOT/<issue>.md\"",
    "result=\"$(rudder library file ref \"$RUDDER_PROJECT_LIBRARY_PATH/<issue>.md\" --json)\"",
    "printf '%s\\n' \"$result\" | jq -r .markdownLink",
    "",
    "mkdir -p \"$RUDDER_ORG_WORKSPACE_ROOT/artifacts/YYYY-MM-DD/<conversation-title>\"",
    "printf '%s\\n' \"<markdown body>\" > \"$RUDDER_ORG_WORKSPACE_ROOT/artifacts/YYYY-MM-DD/<conversation-title>/<artifact>.md\"",
    "result=\"$(rudder library file ref \"artifacts/YYYY-MM-DD/<conversation-title>/<relative-file>\" --json)\"",
    "printf '%s\\n' \"$result\" | jq -r .markdownLink",
    "```",
    "",
    "The relevant JSON fields are:",
    "",
    "- `libraryEntryId`: stable identity for the Library file.",
    "- `mentionHref`: raw `library-entry://<id>` target, optionally with a",
    "  Rudder-generated `p` query parameter as a path hint for the current Library",
    "  path.",
    "- `markdownLink`: complete Markdown link that the renderer turns into a Library",
    "  chip. Its identity remains the entry id; any `p` query value is only a",
    "  synchronous navigation hint and agents should not hand-write it.",
    "",
    "Use `rudder library file get/put` only when local filesystem access to the",
    "Library is unavailable, such as remote or restricted runtimes. `rudder library",
    "file link <path> --json` remains as a compatibility alias for `ref`. The",
    "`ref` path is Library-relative, for example",
    "`$RUDDER_PROJECT_LIBRARY_PATH/<relative-file>` with project context or",
    "`artifacts/YYYY-MM-DD/<conversation-title>/<relative-file>` without project",
    "context; do not pass absolute filesystem paths such as",
    "`$RUDDER_PROJECT_LIBRARY_ROOT/...` or `$RUDDER_ORG_WORKSPACE_ROOT/...`. Posting",
    "the returned `markdownLink` is the Rudder-visible handoff checkpoint for direct",
    "filesystem writes. If `$RUDDER_PROJECT_LIBRARY_ROOT` is unset or inaccessible",
    "but `$RUDDER_PROJECT_LIBRARY_PATH` exists, use",
    "`rudder library file get/put \"$RUDDER_PROJECT_LIBRARY_PATH/<relative-file>\"` as",
    "the remote or restricted runtime fallback. If there is no project context, use",
    "the organization artifacts fallback path instead. Treat `library-file://...` as",
    "legacy weak path syntax and use it only when preserving old content that has no",
    "`libraryEntryId`.",
    "",
    "## Git Identity Policy",
    "",
    "Codex local runs preserve the operator `HOME` for host CLI auth while using managed `CODEX_HOME` and Git sidecars for runtime isolation. Codex local runs and runtime-created git worktrees are prepared with `user.useConfigOnly=true` so missing identity fails fast instead of producing `*@*.local` commits. If Git reports missing author or committer identity, configure the repository explicitly with `git config user.name <name>` and `git config user.email <safe-email>`; do not unset the guard or accept auto-detected local-host metadata.",
    "",
    "## Reviewer Close-Out Signals",
    "",
    "When the inbox row or wake context says `relationship: \"reviewer\"`, `role: \"reviewer\"`, or `wakeSource: \"review\"`, finish the review with one structured reviewer decision. Reviewer work can be either `in_review` or `blocked`; blocked reviewer work means blocker triage, not implementation takeover.",
    "",
    "- approve: `rudder issue review <issue> --decision approve --comment-file <path>`",
    "- request changes: `rudder issue review <issue> --decision request_changes --comment-file <path>`",
    "- needs follow-up: `rudder issue review <issue> --decision needs_followup --comment-file <path>`",
    "- blocked or blocker confirmed: `rudder issue review <issue> --decision blocked --comment-file <path>`; use this only for a confirmed human/external blocker and name the next human action.",
    "",
    "Do not rely on a free-form reject or accept comment as the review outcome. The structured decision is the durable close-out signal. If a blocked reviewer decision needs human input, name the next human action in the review comment; Rudder records only the reviewer decision and removes the issue from repeated reviewer pickup until the board changes the issue.",
  );

  lines.push("", "## Compatibility Commands", "");
  for (const capability of AGENT_CLI_CAPABILITIES.filter((entry) => entry.contract === "compat")) {
    lines.push(`- \`${capability.command}\` — ${capability.description}`);
  }

  return lines.join("\n") + "\n";
}

export function formatAgentCliCapabilitiesHumanReadable(
  capabilities: AgentCliCapability[] = getAgentCliCapabilities(),
): string {
  const lines: string[] = [];

  for (const category of Object.keys(CATEGORY_TITLES) as AgentCliCapabilityCategory[]) {
    const entries = capabilities.filter((capability) => capability.category === category);
    if (entries.length === 0) continue;
    lines.push(`${CATEGORY_TITLES[category]} commands:`);
    for (const entry of entries) {
      const tags = [
        entry.contract,
        entry.mutating ? "mutating" : "read-only",
        entry.requiresOrgId ? "org" : null,
        entry.requiresAgentId ? "agent" : null,
        entry.attachesRunIdWhenAvailable ? "run-id" : null,
      ].filter(Boolean);
      lines.push(`- ${entry.command} — ${entry.description} [${tags.join(", ")}]`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}
