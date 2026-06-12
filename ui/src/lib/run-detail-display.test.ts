import { describe, expect, it } from "vitest";

import { getRunFailureDisplay, getRunStderrExcerptDisplayText, shouldShowRunStderrExcerpt } from "./run-detail-display";

describe("shouldShowRunStderrExcerpt", () => {
  it("does not promote stderr excerpts for successful runs", () => {
    expect(shouldShowRunStderrExcerpt({
      status: "succeeded",
      stderrExcerpt: "2026-05-15 ERROR rmcp::transport::worker: worker quit with fatal",
    })).toBe(false);
  });

  it("does not promote stderr excerpts for failed and timed-out runs", () => {
    expect(shouldShowRunStderrExcerpt({
      status: "failed",
      stderrExcerpt: "runtime failed",
    })).toBe(false);

    expect(shouldShowRunStderrExcerpt({
      status: "timed_out",
      stderrExcerpt: "runtime stopped responding",
    })).toBe(false);
  });

  it("ignores empty stderr excerpts", () => {
    expect(shouldShowRunStderrExcerpt({
      status: "failed",
      stderrExcerpt: "  ",
    })).toBe(false);
  });

  it("filters benign Codex runtime noise from run stderr display", () => {
    const stderrExcerpt = [
      "2026-05-15T06:57:31.977213Z ERROR codex_models_manager::manager: failed to refresh available models: timeout waiting for child process to exit",
      "2026-05-15T06:57:34.139709Z ERROR codex_memories_write::phase2: Phase 2 no changes",
      "2026-05-15T06:57:44.058316Z ERROR codex_core::models_manager::manager: failed to refresh available models: timeout waiting for child process to exit",
    ].join("\n");

    expect(getRunStderrExcerptDisplayText({
      status: "failed",
      stderrExcerpt,
    })).toBe("");
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
      body: "Rudder could not verify write access to its managed agent workspace before starting the run.",
      code: "workspace_permission_repair_needed",
      tone: "destructive",
      actionLabel: "Open instance details",
      actionPath: "/instance/settings/about",
    });
  });

  it("uses a generic user-facing message for runtime failures", () => {
    expect(getRunFailureDisplay({
      error: "Chat adapter completed without the required Rudder result sentinel",
      errorCode: "adapter_failed",
    })).toEqual({
      title: "Run failed",
      body: "The run hit a system-level execution problem. Rudder saved the technical details for diagnostics.",
      code: "adapter_failed",
      tone: "destructive",
    });
  });

  it("labels cancelled runs separately from system failures", () => {
    expect(getRunFailureDisplay({
      status: "cancelled",
      error: "Cancelled because the linked issue is no longer actionable",
      errorCode: "cancelled",
    })).toEqual({
      title: "Run cancelled",
      body: "The run was cancelled before it could continue. Rudder kept the cancellation reason for context.",
      code: "cancelled",
      tone: "neutral",
    });
  });
});
