import { describe, expect, it } from "vitest";

import { getRunFailureDisplay, getRunStderrExcerptDisplayText, shouldShowRunStderrExcerpt } from "./run-detail-display";

describe("shouldShowRunStderrExcerpt", () => {
  it("does not promote stderr excerpts for successful runs", () => {
    expect(shouldShowRunStderrExcerpt({
      status: "succeeded",
      stderrExcerpt: "2026-05-15 ERROR rmcp::transport::worker: worker quit with fatal",
    })).toBe(false);
  });

  it("shows stderr excerpts for failed and timed-out runs", () => {
    expect(shouldShowRunStderrExcerpt({
      status: "failed",
      stderrExcerpt: "runtime failed",
    })).toBe(true);

    expect(shouldShowRunStderrExcerpt({
      status: "timed_out",
      stderrExcerpt: "runtime stopped responding",
    })).toBe(true);
  });

  it("ignores empty stderr excerpts", () => {
    expect(shouldShowRunStderrExcerpt({
      status: "failed",
      stderrExcerpt: "  ",
    })).toBe(false);
  });

  it("filters benign Codex model refresh timeout noise from run stderr display", () => {
    const stderrExcerpt = [
      "2026-05-15T06:57:31.977213Z ERROR codex_models_manager::manager: failed to refresh available models: timeout waiting for child process to exit",
      "2026-05-15T06:57:34.139709Z ERROR codex_memories_write::phase2: Phase 2 no changes",
      "2026-05-15T06:57:44.058316Z ERROR codex_core::models_manager::manager: failed to refresh available models: timeout waiting for child process to exit",
    ].join("\n");

    expect(getRunStderrExcerptDisplayText({
      status: "failed",
      stderrExcerpt,
    })).toBe("2026-05-15T06:57:34.139709Z ERROR codex_memories_write::phase2: Phase 2 no changes");
  });

  it("does not show stderr excerpts that only contain benign Codex model refresh timeouts", () => {
    expect(shouldShowRunStderrExcerpt({
      status: "failed",
      stderrExcerpt: "2026-05-15T06:57:31.977213Z ERROR codex_models_manager::manager: failed to refresh available models: timeout waiting for child process to exit",
    })).toBe(false);
  });
});

describe("getRunFailureDisplay", () => {
  it("labels workspace permission preflight failures separately from agent failures", () => {
    expect(getRunFailureDisplay({
      error: "Rudder workspace permission repair needed: managed life path is not writable: /tmp/agent/life (EACCES).",
      errorCode: "workspace_permission_repair_needed",
    })).toEqual({
      title: "Workspace permission repair needed",
      body: "Rudder workspace permission repair needed: managed life path is not writable: /tmp/agent/life (EACCES).",
      code: "workspace_permission_repair_needed",
      actionLabel: "Open instance details",
      actionPath: "/instance/settings/about",
    });
  });
});
