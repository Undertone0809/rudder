import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildAgentCliCapabilitiesManifest,
  renderAgentCliReferenceMarkdown,
} from "../agent-v1-registry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_REFERENCE_PATH = path.resolve(
  __dirname,
  "../../../server/resources/bundled-skills/rudder/references/cli-reference.md",
);

describe("agent-v1 registry", () => {
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

  it("keeps the CLI reference doc in sync with the registry", () => {
    const reference = fs.readFileSync(CLI_REFERENCE_PATH, "utf8");
    expect(reference).toBe(renderAgentCliReferenceMarkdown());
  });
});
