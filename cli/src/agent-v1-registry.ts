export type AgentCliCapabilityCategory = "agent" | "issue" | "approval" | "skill";
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
    command: "rudder agent get <agent-id-or-shortname>",
    category: "agent",
    description: "Read one agent by id or shortname.",
    mutating: false,
    contract: "compat",
    requiresOrgId: false,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: false,
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
    command: "rudder issue context <issue>",
    category: "issue",
    description: "Read the compact heartbeat context for an issue.",
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
    command: "rudder issue comments list <issue>",
    category: "issue",
    description: "List issue comments, optionally only newer comments after a cursor.",
    mutating: false,
    contract: "agent-v1",
    requiresOrgId: false,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: false,
  },
  {
    id: "issue.comments.get",
    command: "rudder issue comments get <issue> <comment-id>",
    category: "issue",
    description: "Read one issue comment by id.",
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
    id: "issue.release",
    command: "rudder issue release <issue>",
    category: "issue",
    description: "Release an issue back to todo and clear ownership.",
    mutating: true,
    contract: "agent-v1",
    requiresOrgId: false,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: true,
  },
  {
    id: "issue.documents.list",
    command: "rudder issue documents list <issue>",
    category: "issue",
    description: "List issue documents.",
    mutating: false,
    contract: "agent-v1",
    requiresOrgId: false,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: false,
  },
  {
    id: "issue.documents.get",
    command: "rudder issue documents get <issue> <key>",
    category: "issue",
    description: "Read one issue document by key.",
    mutating: false,
    contract: "agent-v1",
    requiresOrgId: false,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: false,
  },
  {
    id: "issue.documents.put",
    command: "rudder issue documents put <issue> <key> --body-file <path>",
    category: "issue",
    description: "Create or update an issue document.",
    mutating: true,
    contract: "agent-v1",
    requiresOrgId: false,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: true,
  },
  {
    id: "issue.documents.revisions",
    command: "rudder issue documents revisions <issue> <key>",
    category: "issue",
    description: "List revisions for an issue document.",
    mutating: false,
    contract: "agent-v1",
    requiresOrgId: false,
    requiresAgentId: false,
    requiresRunId: false,
    attachesRunIdWhenAvailable: false,
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
];

const CATEGORY_TITLES: Record<AgentCliCapabilityCategory, string> = {
  agent: "Agent",
  issue: "Issue",
  approval: "Approval",
  skill: "Skill",
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

export function renderAgentCliReferenceMarkdown(): string {
  const manifest = buildAgentCliCapabilitiesManifest("agent-v1");
  const lines: string[] = [
    "# Rudder Agent CLI Reference",
    "",
    "Stable CLI contract for agents using the bundled `rudder` skill. Prefer these commands over direct `/api` calls.",
    "",
    "## Defaults",
    "",
    "- All commands support `--json`.",
    "- `--org-id` defaults to `RUDDER_ORG_ID` when relevant.",
    "- `--run-id` defaults to `RUDDER_RUN_ID` and is attached to mutating requests when available.",
    "- `issue checkout` defaults `--agent-id` from `RUDDER_AGENT_ID`.",
    "",
    "## JSON Output Contract",
    "",
    "`rudder ... --json` commands must write valid JSON to stdout on success. If a command cannot produce the requested JSON, it must exit nonzero and write a diagnostic error to stderr. An exit-0 command with empty stdout is a CLI/runtime defect, not a valid empty result.",
    "",
    "Direct API fallback is allowed for heartbeat close-out only when a required CLI command fails diagnostically or returns exit 0 with empty stdout. When using fallback, note the affected command and reason in the issue comment or run notes so the CLI path can be fixed.",
    "",
    "## Agent V1 Commands",
    "",
    "| Command | Description | Mutating | Org | Agent | Run ID |",
    "| --- | --- | --- | --- | --- | --- |",
  ];

  for (const capability of manifest.capabilities) {
    lines.push(
      `| \`${capability.command}\` | ${capability.description} | ${capability.mutating ? "yes" : "no"} | ${
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
    "If an issue has a reviewer, moving it to `blocked` is also a reviewer handoff: the reviewer should confirm the blocker, request changes, approve, or keep explicit follow-up open with `rudder issue review`.",
    "",
    "Issue comment and close-out commands accept comment bodies only from files or stdin. For any multiline Markdown, command names, code spans, code blocks, test summaries, or screenshot evidence, write the comment to a temporary Markdown file and pass `--body-file <path>` or `--comment-file <path>`, or pass `-` to read the body from stdin.",
    "",
    "`--image` may be repeated. The CLI uploads each local PNG/JPEG/WebP/GIF as an issue attachment and appends Markdown image links to the comment text before sending it.",
    "",
    "If your issue comment cites a screenshot path or visual validation artifact, attach that file with `--image <path>` instead of leaving only the local path in the text.",
    "",
    "If `RUDDER_WAKE_REASON=issue_passive_followup`, the run is close-out governance for the same issue. Inspect current issue state first, then leave a progress comment, completion, blocker, or explicit handoff.",
    "",
    "## Git Identity Policy",
    "",
    "Local runtime `HOME` is isolated from the operator home. Codex local runs and runtime-created git worktrees are prepared with `user.useConfigOnly=true` so missing identity fails fast instead of producing `*@*.local` commits. If Git reports missing author or committer identity, configure the repository explicitly with `git config user.name <name>` and `git config user.email <safe-email>`; do not unset the guard or accept auto-detected local-host metadata.",
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
    "Do not rely on a free-form reject or accept comment as the review outcome. The structured decision is the durable close-out signal. A blocked reviewer decision records a human handoff and removes the issue from repeated reviewer pickup until the board changes the issue.",
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
