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
      "agent.skills.sync",
      "issue.get",
      "issue.context",
      "issue.checkout",
      "issue.comment",
      "issue.comments.list",
      "issue.comments.get",
      "issue.update",
      "issue.done",
      "issue.block",
      "issue.release",
      "issue.documents.list",
      "issue.documents.get",
      "issue.documents.put",
      "issue.documents.revisions",
      "approval.get",
      "approval.issues",
      "approval.comment",
      "skill.list",
      "skill.get",
      "skill.file",
      "skill.import",
      "skill.scan-local",
      "skill.scan-projects",
    ]);
  });

  it("keeps the CLI reference doc in sync with the registry", () => {
    const reference = fs.readFileSync(CLI_REFERENCE_PATH, "utf8");
    expect(reference).toBe(renderAgentCliReferenceMarkdown());
  });
});
