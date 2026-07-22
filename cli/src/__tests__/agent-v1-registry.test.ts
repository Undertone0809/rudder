import {
  RUDDER_BROWSER_MCP_CONTRACT_HASH,
  RUDDER_CORE_MCP_CONTRACT_HASH,
  RUDDER_CORE_MCP_TOOL_NAMES,
  RUDDER_MCP_CANONICAL_TOOL_CONTRACTS,
  RUDDER_MCP_CANONICAL_TOOL_DEFINITIONS,
  rudderMcpSemanticToolContract,
} from "@rudderhq/agent-runtime-utils";
import { fingerprintRudderMcpToolManifest } from "@rudderhq/agent-runtime-utils/rudder-mcp-fingerprint";
import {
  RUDDER_AGENT_V1_MCP_SERVER_NAME,
  RUDDER_AGENT_V1_MCP_TOOL_NAMES,
  RUDDER_BROWSER_MCP_SERVER_NAME,
  RUDDER_BROWSER_MCP_TOOL_NAMES,
} from "@rudderhq/shared";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildAgentCliCapabilitiesManifest,
  buildAgentV1McpToolsManifest,
  renderAgentCliReferenceMarkdown,
} from "../agent-v1-registry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_REFERENCE_PATH = path.resolve(
  __dirname,
  "../../../server/resources/bundled-skills/rudder-docs/references/cli-reference.md",
);

describe("agent-v1 registry", () => {
  const browserToolNames = RUDDER_AGENT_V1_MCP_TOOL_NAMES.filter((name) => name.startsWith("rudder_browser_"));
  const coreToolNames = RUDDER_AGENT_V1_MCP_TOOL_NAMES.filter((name) => !name.startsWith("rudder_browser_"));

  it("builds a stable agent-v1 capabilities manifest", () => {
    const manifest = buildAgentCliCapabilitiesManifest("agent-v1");

    expect(manifest.schema).toBe("rudder.agent-capabilities/v1");
    expect(manifest.contract).toBe("agent-v1");
    expect(manifest.defaults).toEqual({
      orgIdEnvVar: "RUDDER_ORG_ID",
      agentIdEnvVar: "RUDDER_AGENT_ID",
      runIdEnvVar: "RUDDER_RUN_ID",
      jsonErrors: "stderr-error-envelope",
    });
    expect(manifest.capabilities.every((entry) => entry.agentV1)).toBe(true);
    expect(manifest.capabilities.map((entry) => entry.id)).toEqual([
      "agent.me",
      "agent.inbox",
      "agent.capabilities",
      "agent.update",
      "agent.skills.create",
      "agent.skills.enable",
      "agent.skills.sync",
      "issue.get",
      "issue.search",
      "issue.context",
      "issue.checkout",
      "issue.comment",
      "issue.comments.list",
      "issue.comments.get",
      "issue.update",
      "issue.review",
      "issue.commit",
      "issue.done",
      "issue.block",
      "project.list",
      "project.get",
      "project.create",
      "project.update",
      "user.activity",
      "library.file.list",
      "library.file.get",
      "library.file.ref",
      "library.file.link",
      "library.file.put",
      "approval.get",
      "approval.issues",
      "approval.comment",
      "skill.list",
      "skill.get",
      "skill.file",
      "skill.import",
      "skill.scan-local",
      "skill.scan-projects",
      "browser.tabs",
      "browser.user-tabs",
      "browser.open",
      "browser.navigate",
      "browser.back",
      "browser.forward",
      "browser.reload",
      "browser.viewport",
      "browser.visibility",
      "browser.snapshot",
      "browser.locator",
      "browser.cua",
      "browser.dom-cua",
      "browser.dialog",
      "browser.clipboard",
      "browser.logs",
      "browser.download",
      "browser.assets",
      "browser.content",
      "browser.wait",
      "browser.read",
      "browser.click",
      "browser.type",
      "browser.screenshot",
      "browser.close",
      "automation.list",
      "automation.get",
      "automation.runs",
      "automation.triggers.list",
      "automation.triggers.create",
      "automation.triggers.update",
      "automation.triggers.delete",
      "automation.triggers.rotate-secret",
      "automation.create",
      "automation.update",
      "automation.enable",
      "automation.disable",
      "automation.run",
      "chat.list",
      "chat.search",
      "chat.get",
      "chat.messages",
      "chat.transcript",
      "chat.read",
      "chat.create",
      "chat.send",
      "chat.archive",
      "runs.list",
      "runs.by-skill",
      "runs.get",
      "runs.events",
      "runs.log",
      "runs.transcript",
      "runs.errors",
      "runs.cancel",
      "runs.retry",
    ]);
  });

  it("marks automation trigger mutation commands as mutating agent-v1 capabilities", () => {
    const manifest = buildAgentCliCapabilitiesManifest("agent-v1");
    const byId = new Map(manifest.capabilities.map((entry) => [entry.id, entry]));

    for (const id of [
      "automation.triggers.create",
      "automation.triggers.update",
      "automation.triggers.delete",
      "automation.triggers.rotate-secret",
    ]) {
      const capability = byId.get(id);
      expect(capability).toBeDefined();
      expect(capability?.mutating).toBe(true);
      expect(capability?.attachesRunIdWhenAvailable).toBe(true);
    }
  });

  it("exposes chat send as an agent-authored direct message capability", () => {
    const manifest = buildAgentCliCapabilitiesManifest("agent-v1");
    const chatSend = manifest.capabilities.find((entry) => entry.id === "chat.send");

    expect(chatSend).toMatchObject({
      command: "rudder chat send <chat-id> --body <text>",
      description: "Send an agent-authored message directly to the operator in a chat.",
      mutating: true,
      requiresAgentId: true,
      attachesRunIdWhenAvailable: true,
    });
  });

  it("requires a body in the chat create MCP contract", () => {
    const chatCreate = buildAgentV1McpToolsManifest("agent-v1").tools
      .find((tool) => tool.capabilityId === "chat.create");

    expect(chatCreate?.inputSchema.properties).toHaveProperty("body");
    expect(chatCreate?.inputSchema.required).toContain("body");
  });

  it("builds stable core MCP metadata without Browser tools", () => {

    const cliManifest = buildAgentCliCapabilitiesManifest("agent-v1");
    const mcpManifest = buildAgentV1McpToolsManifest("agent-v1");

    expect(mcpManifest.schema).toBe("rudder.agent-mcp-tools/v1");
    expect(mcpManifest.contract).toBe("agent-v1");
    expect(mcpManifest.serverName).toBe(RUDDER_AGENT_V1_MCP_SERVER_NAME);
    expect(mcpManifest.tools).toHaveLength(
      cliManifest.capabilities.length - browserToolNames.length,
    );
    expect(mcpManifest.tools.map((tool) => tool.name)).toEqual(coreToolNames);

    expect(mcpManifest.tools.every((tool) => tool.category !== "browser")).toBe(true);
    expect(mcpManifest.tools.map((tool) => tool.name)).toContain("rudder_issue_checkout");
    expect(mcpManifest.tools.map((tool) => tool.name)).toContain("rudder_runs_errors");
    expect(mcpManifest.tools.map((tool) => tool.name)).not.toContain("rudder_browser_open");
    expect(mcpManifest.tools.find((tool) => tool.capabilityId === "issue.checkout")).toMatchObject({
      name: "rudder_issue_checkout",
      mutating: true,
      attachesRunIdWhenAvailable: true,
    });
    expect(mcpManifest.tools.find((tool) => tool.capabilityId === "agent.me")).toMatchObject({
      name: "rudder_agent_me",
      mutating: false,
      attachesRunIdWhenAvailable: false,
    });
  });

  it("keeps the lightweight runtime core manifest aligned with the canonical registry", () => {
    expect(RUDDER_CORE_MCP_TOOL_NAMES).toEqual(
      RUDDER_AGENT_V1_MCP_TOOL_NAMES.filter((name) => !name.startsWith("rudder_browser_")),
    );
  });

  it("derives core and Browser semantic hashes from the canonical tool manifest", () => {
    const tools = buildAgentV1McpToolsManifest("agent-v1", { surface: "all" }).tools
      .map(rudderMcpSemanticToolContract);
    expect(tools).toEqual(RUDDER_MCP_CANONICAL_TOOL_CONTRACTS);
    expect(fingerprintRudderMcpToolManifest(
      tools.filter((tool) => !tool.name.startsWith("rudder_browser_")),
    )).toBe(RUDDER_CORE_MCP_CONTRACT_HASH);
    expect(fingerprintRudderMcpToolManifest(
      tools.filter((tool) => tool.name.startsWith("rudder_browser_")),
    )).toBe(RUDDER_BROWSER_MCP_CONTRACT_HASH);
  });

  it("keeps generated semantic descriptors aligned with the CLI capability registry", () => {
    const capabilities = buildAgentCliCapabilitiesManifest("agent-v1").capabilities;
    expect(RUDDER_MCP_CANONICAL_TOOL_DEFINITIONS.map((tool) => ({
      id: tool.capabilityId,
      description: tool.description,
      mutating: tool.mutating,
      requiresOrgId: tool.requiresOrgId,
      requiresAgentId: tool.requiresAgentId,
      attachesRunIdWhenAvailable: tool.attachesRunIdWhenAvailable,
    }))).toEqual(capabilities.map((capability) => ({
      id: capability.id,
      description: capability.description,
      mutating: capability.mutating,
      requiresOrgId: capability.requiresOrgId,
      requiresAgentId: capability.requiresAgentId,
      attachesRunIdWhenAvailable: capability.attachesRunIdWhenAvailable,
    })));
  });

  it("builds a separate Browser-only MCP manifest without changing the CLI contract", () => {
    const cliManifest = buildAgentCliCapabilitiesManifest("agent-v1");
    const core = buildAgentV1McpToolsManifest("agent-v1");
    const browser = buildAgentV1McpToolsManifest("agent-v1", { surface: "browser" });

    expect(cliManifest.capabilities.map((entry) => entry.id)).toContain("browser.open");
    expect(core.serverName).toBe(RUDDER_AGENT_V1_MCP_SERVER_NAME);
    expect(core.tools.map((tool) => tool.name)).not.toContain("rudder_browser_open");
    expect(browser.serverName).toBe(RUDDER_BROWSER_MCP_SERVER_NAME);
    expect(browser.tools.map((tool) => tool.name)).toEqual([...RUDDER_BROWSER_MCP_TOOL_NAMES]);
    expect(browser.tools.every((tool) => tool.category === "browser")).toBe(true);
    expect(browser.tools.find((tool) => tool.capabilityId === "browser.locator")?.inputSchema).toMatchObject({
      properties: {
        dialogResponse: {
          required: ["accept"],
          properties: {
            accept: { type: "boolean" },
            promptText: { type: "string", maxLength: 10_000 },
          },
        },
      },
    });
    expect(core.tools).toHaveLength(cliManifest.capabilities.length - browser.tools.length);

  });

  it("keeps compat commands out of the MCP manifest even when CLI capabilities include all", () => {
    const allCliManifest = buildAgentCliCapabilitiesManifest("all");
    const mcpManifest = buildAgentV1McpToolsManifest("agent-v1");

    expect(allCliManifest.capabilities.map((entry) => entry.id)).toContain("agent.list");
    expect(mcpManifest.tools.map((tool) => tool.capabilityId)).not.toContain("agent.list");
    expect(mcpManifest.tools.every((tool) => tool.contract === "agent-v1")).toBe(true);
  });

  it("keeps the CLI reference doc in sync with the registry", () => {
    const reference = fs.readFileSync(CLI_REFERENCE_PATH, "utf8");
    expect(reference).toBe(renderAgentCliReferenceMarkdown());
  });
});
