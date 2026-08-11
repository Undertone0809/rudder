import { RUDDER_MCP_CANONICAL_TOOL_DEFINITIONS } from "@rudderhq/agent-runtime-utils";
import { AGENT_CLI_CAPABILITIES } from "./agent-v1-capabilities.js";

export type AgentCliCapabilityCategory =
  | "agent"
  | "goal"
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
    required?: string[];
  };
  outputMode: "json";
}

export interface AgentV1McpToolsManifest {
  schema: "rudder.agent-mcp-tools/v1";
  contract: AgentCliCapabilityContract | "all";
  serverName: "rudder-tools" | "rudder-browser";
  tools: AgentV1McpToolManifestEntry[];
}

export type AgentV1McpSurface = "core" | "browser" | "all";

const CATEGORY_TITLES: Record<AgentCliCapabilityCategory, string> = {
  agent: "Agent",
  goal: "Goal",
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

export function buildAgentV1McpToolsManifest(
  contract: AgentCliCapabilityContract | "all" = "agent-v1",
  options: { browserEnabled?: boolean; surface?: AgentV1McpSurface } = {},
): AgentV1McpToolsManifest {
  const surface = options.surface ?? "core";
  const capabilities = buildAgentCliCapabilitiesManifest(contract).capabilities
    .filter((entry) => {
      if (surface === "all") return true;
      if (surface === "browser") return entry.category === "browser";
      return entry.category !== "browser";
    });

  const semanticContractByCapability = new Map<string, (typeof RUDDER_MCP_CANONICAL_TOOL_DEFINITIONS)[number]>(
    RUDDER_MCP_CANONICAL_TOOL_DEFINITIONS.map((tool) => [tool.capabilityId, tool]),
  );

  return {
    schema: "rudder.agent-mcp-tools/v1",
    contract,
    serverName: surface === "browser" ? "rudder-browser" : "rudder-tools",
    tools: capabilities.map((entry) => {
      const semanticContract = semanticContractByCapability.get(entry.id);
      if (!semanticContract) {
        throw new Error(`Missing canonical Rudder MCP contract for capability: ${entry.id}`);
      }
      return {
        ...entry,
        description: semanticContract.description,
        capabilityId: entry.id,
        name: semanticContract.name,
        inputSchema: semanticContract.inputSchema,
        outputMode: "json" as const,
      };
    }),
  };
}

export function renderAgentCliReferenceMarkdown(): string {
  const manifest = buildAgentCliCapabilitiesManifest("agent-v1");
  const mcpManifest = buildAgentV1McpToolsManifest("agent-v1", { surface: "all" });
  const mcpByCapability = new Map(mcpManifest.tools.map((tool) => [tool.capabilityId, tool]));
  const lines: string[] = [
    "# Rudder Agent CLI Reference",
    "",
    "Stable typed-tool and CLI fallback catalog for the bundled `rudder-docs`",
    "package. Prefer first-party Rudder MCP tools when the runtime exposes them; use",
    "these CLI commands as fallback when MCP is unavailable or a Rudder MCP tool",
    "returns a transport or configuration error.",
    "",
    "## Section Map",
    "",
    "- [Operating policy owners](#operating-policy-owners)",
    "- [Defaults](#defaults)",
    "- [JSON output contract](#json-output-contract)",
    "- [Agent V1 commands](#agent-v1-commands)",
    "- [Issue command I/O and shapes](#issue-command-io-and-shapes)",
    "- [Renderable Library CLI output](#renderable-library-cli-output)",
    "- [Reviewer decision command shapes](#reviewer-decision-command-shapes)",
    "- [Compatibility commands](#compatibility-commands)",
    "",
    "## Operating Policy Owners",
    "",
    "Keep this file focused on commands and CLI-specific I/O. Consult the exact",
    "operating-practices guide for operating behavior:",
    "",
    "- [Interface and Chat/issue scope](operating-practices.md#interface-and-scope)",
    "- [Ownership, checkout, and wake scope](operating-practices.md#ownership-checkout-and-wake-scope)",
    "- [Comments, mentions, and evidence](operating-practices.md#comments-mentions-and-evidence)",
    "- [Review and close-out](operating-practices.md#review-and-close-out)",
    "- [Durable Library artifacts](operating-practices.md#durable-library-artifacts)",
    "- [Git identity and attribution](operating-practices.md#git-identity-and-attribution)",
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
    "## Issue Command I/O And Shapes",
    "",
    "Operating rules live in [ownership, checkout, and wake scope](operating-practices.md#ownership-checkout-and-wake-scope), [comments and evidence](operating-practices.md#comments-mentions-and-evidence), and [review and close-out](operating-practices.md#review-and-close-out). The CLI close-out shapes are:",
    "",
    "- progress: `rudder issue comment <issue> --body-file <path> [--image <path>]`",
    "- done: `rudder issue done <issue> --comment-file <path> [--image <path>]`",
    "- assistance/block audit: `rudder issue block <issue> --comment-file <path> [--image <path>]`",
    "",
    "Issue comment and close-out commands accept comment bodies only from files or stdin. For multiline Markdown, command names, code spans, code blocks, test summaries, or screenshot evidence, pass `--body-file <path>` or `--comment-file <path>`, or pass `-` to read the body from stdin.",
    "",
    "Issue comment responses include `shortRef` when available. `rudder issue comments get <issue> <comment-id-or-cmt-ref>` accepts a full comment UUID or `cmt_<uuid-prefix>`, and `rudder issue comments list <issue> --after <comment-id-or-cmt-ref>` accepts the same forms for the pagination anchor. Use the full UUID when a short ref is ambiguous within the issue.",
    "",
    "`--image` may be repeated. The CLI uploads each local PNG/JPEG/WebP/GIF as an issue attachment and appends Markdown image links to the comment text before sending it.",
    "",
    "## Renderable Library CLI Output",
    "",
    "File placement and handoff policy lives in [Durable Library artifacts](operating-practices.md#durable-library-artifacts). Request a renderable reference with `rudder library file ref <library-relative-path> --json`.",
    "",
    "The relevant JSON fields are:",
    "",
    "- `libraryEntryId`: stable identity for the Library file.",
    "- `mentionHref`: raw renderable target, optionally with a Rudder-generated path hint.",
    "- `markdownLink`: complete Markdown link for the renderer.",
    "",
    "The `ref` argument is Library-relative, not an absolute filesystem path. CLI fallback shapes are `rudder library file get <library-relative-path> --json` and `rudder library file put <library-relative-path> --body-file <path> --json`. `rudder library file link <library-relative-path> --json` remains a compatibility alias for `ref`.",
    "",
    "## Reviewer Decision Command Shapes",
    "",
    "Reviewer policy lives in [Review and close-out](operating-practices.md#review-and-close-out). Supported decision command shapes are:",
    "",
    "- `rudder issue review <issue> --decision approve --comment-file <path>`",
    "- `rudder issue review <issue> --decision request_changes --comment-file <path>`",
    "- `rudder issue review <issue> --decision needs_followup --comment-file <path>`",
    "- `rudder issue review <issue> --decision blocked --comment-file <path>`",
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
