import { describe, expect, it } from "vitest";
import {
  agentSkillEntrySchema,
  agentSkillSnapshotSchema,
} from "@rudder/shared/validators/adapter-skills";

describe("agent skill contract", () => {
  it("accepts source-aware provenance metadata on skill entries", () => {
    expect(agentSkillEntrySchema.parse({
      key: "crack-python",
      selectionKey: "adapter:claude_local:crack-python",
      runtimeName: "crack-python",
      description: "Local crack-python skill.",
      desired: false,
      configurable: true,
      alwaysEnabled: false,
      managed: false,
      state: "external",
      sourceClass: "adapter_home",
      origin: "user_installed",
      originLabel: "User-installed",
      locationLabel: "~/.claude/skills",
      readOnly: true,
      detail: "Installed outside Rudder management.",
    })).toMatchObject({
      description: "Local crack-python skill.",
      origin: "user_installed",
      locationLabel: "~/.claude/skills",
      readOnly: true,
    });
  });

  it("accepts agent-private skill entries discovered from AGENT_HOME", () => {
    expect(agentSkillEntrySchema.parse({
      key: "build-advisor",
      selectionKey: "agent:build-advisor",
      runtimeName: "build-advisor",
      description: "Private agent skill.",
      desired: true,
      configurable: true,
      alwaysEnabled: false,
      managed: false,
      state: "configured",
      sourceClass: "agent_home",
      origin: "user_installed",
      originLabel: "Agent skill",
      locationLabel: "AGENT_HOME/skills",
    })).toMatchObject({
      selectionKey: "agent:build-advisor",
      sourceClass: "agent_home",
      locationLabel: "AGENT_HOME/skills",
    });
  });

  it("accepts snapshots that include the canonical selection metadata", () => {
    expect(agentSkillSnapshotSchema.parse({
      agentRuntimeType: "claude_local",
      supported: true,
      mode: "ephemeral",
      desiredSkills: [],
      entries: [{
        key: "rudder/rudder",
        selectionKey: "bundled:rudder/rudder",
        runtimeName: "rudder",
        desired: true,
        configurable: false,
        alwaysEnabled: true,
        managed: true,
        state: "configured",
        sourceClass: "bundled",
      }],
      warnings: [],
    })).toMatchObject({
      agentRuntimeType: "claude_local",
      entries: [{
        key: "rudder/rudder",
        selectionKey: "bundled:rudder/rudder",
        state: "configured",
        sourceClass: "bundled",
      }],
    });
  });
});
