import { describe, expect, it } from "vitest";
import {
  applyAgentSkillSnapshot,
  canManageSkillEntry,
  isExternalSkillEntry,
  sortSkillRowsByPinnedSelectionKey,
  toggleSkillSelection,
} from "./agent-skills-state";

describe("applyAgentSkillSnapshot", () => {
  it("hydrates the initial snapshot without arming autosave", () => {
    const result = applyAgentSkillSnapshot(
      {
        draft: [],
        lastSaved: [],
        hasHydratedSnapshot: false,
      },
      ["rudder", "para-memory-files"],
    );

    expect(result).toEqual({
      draft: ["para-memory-files", "rudder"],
      lastSaved: ["para-memory-files", "rudder"],
      hasHydratedSnapshot: true,
      shouldSkipAutosave: true,
    });
  });

  it("keeps unsaved local edits when a fresh snapshot arrives", () => {
    const result = applyAgentSkillSnapshot(
      {
        draft: ["rudder", "custom-skill"],
        lastSaved: ["rudder"],
        hasHydratedSnapshot: true,
      },
      ["rudder"],
    );

    expect(result).toEqual({
      draft: ["rudder", "custom-skill"],
      lastSaved: ["rudder"],
      hasHydratedSnapshot: true,
      shouldSkipAutosave: false,
    });
  });

  it("adopts server state after a successful save and skips the follow-up autosave pass", () => {
    const result = applyAgentSkillSnapshot(
      {
        draft: ["rudder", "custom-skill"],
        lastSaved: ["rudder", "custom-skill"],
        hasHydratedSnapshot: true,
      },
      ["rudder", "custom-skill"],
    );

    expect(result).toEqual({
      draft: ["custom-skill", "rudder"],
      lastSaved: ["custom-skill", "rudder"],
      hasHydratedSnapshot: true,
      shouldSkipAutosave: true,
    });
  });

  it("treats user-installed entries outside the organization library as external skills", () => {
    expect(isExternalSkillEntry({
      selectionKey: "global:crack-python",
      key: "crack-python",
      runtimeName: "crack-python",
      desired: false,
      configurable: true,
      alwaysEnabled: false,
      managed: false,
      state: "external",
      sourceClass: "global",
      origin: "user_installed",
    })).toBe(true);
  });

  it("treats AGENT_HOME skills as external-to-organization selections", () => {
    expect(isExternalSkillEntry({
      selectionKey: "agent:build-advisor",
      key: "build-advisor",
      runtimeName: "build-advisor",
      desired: true,
      configurable: true,
      alwaysEnabled: false,
      managed: false,
      state: "configured",
      sourceClass: "agent_home",
      origin: "user_installed",
    })).toBe(true);
  });

  it("keeps organization-library entries in the managed section even when the adapter reports an external conflict", () => {
    expect(isExternalSkillEntry({
      selectionKey: "org:rudder/rudder",
      key: "rudder",
      runtimeName: "rudder",
      desired: true,
      configurable: true,
      alwaysEnabled: false,
      managed: false,
      state: "external",
      sourceClass: "organization",
      origin: "organization_managed",
    })).toBe(false);
  });

  it("falls back to legacy snapshots that only mark unmanaged external entries", () => {
    expect(isExternalSkillEntry({
      selectionKey: "adapter:claude_local:legacy-external",
      key: "legacy-external",
      runtimeName: "legacy-external",
      desired: false,
      configurable: true,
      alwaysEnabled: false,
      managed: false,
      state: "external",
      sourceClass: "adapter_home",
    })).toBe(true);
  });

  it("only allows toggling configurable entries", () => {
    expect(canManageSkillEntry({
      selectionKey: "global:build-advisor",
      key: "build-advisor",
      runtimeName: "build-advisor",
      desired: false,
      configurable: true,
      alwaysEnabled: false,
      managed: false,
      state: "external",
      sourceClass: "global",
      origin: "user_installed",
    })).toBe(true);

    expect(canManageSkillEntry({
      selectionKey: "bundled:rudder/para-memory-files",
      key: "para-memory-files",
      runtimeName: "para-memory-files",
      desired: true,
      configurable: false,
      alwaysEnabled: true,
      managed: true,
      state: "configured",
      sourceClass: "bundled",
      origin: "organization_managed",
    })).toBe(false);
  });

  it("switches conflicting same-name entries instead of enabling both", () => {
    const entries = [
      {
        selectionKey: "global:build-advisor",
        key: "build-advisor",
        runtimeName: "build-advisor",
        desired: false,
        configurable: true,
        alwaysEnabled: false,
        managed: false,
        state: "external" as const,
        sourceClass: "global" as const,
      },
      {
        selectionKey: "adapter:claude_local:build-advisor",
        key: "build-advisor",
        runtimeName: "build-advisor",
        desired: false,
        configurable: true,
        alwaysEnabled: false,
        managed: false,
        state: "external" as const,
        sourceClass: "adapter_home" as const,
      },
    ];

    expect(
      toggleSkillSelection(
        ["global:build-advisor"],
        entries[1],
        true,
        entries,
      ),
    ).toEqual(["adapter:claude_local:build-advisor"]);
  });

  it("pins configured skills ahead of the rest while keeping alphabetical order within each group", () => {
    expect(sortSkillRowsByPinnedSelectionKey([
      { selectionKey: "agent:zeta-helper", name: "zeta-helper" },
      { selectionKey: "agent:alpha-helper", name: "alpha-helper" },
      { selectionKey: "agent:beta-helper", name: "beta-helper" },
    ], ["agent:zeta-helper"]).map((row) => row.name)).toEqual([
      "zeta-helper",
      "alpha-helper",
      "beta-helper",
    ]);
  });
});
