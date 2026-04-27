import { describe, expect, it } from "vitest";
import {
  buildHeartbeatAdapterInvokePayload,
  buildHeartbeatRuntimeTraceMetadata,
  buildIssueRunTraceName,
  resolveHeartbeatObservabilitySurface,
} from "../services/heartbeat.js";

describe("heartbeat observability surface", () => {
  it("classifies issue-backed executions as issue runs", () => {
    expect(resolveHeartbeatObservabilitySurface({ issueId: "issue-1" })).toBe("issue_run");
  });

  it("keeps non-issue executions as heartbeat runs", () => {
    expect(resolveHeartbeatObservabilitySurface({})).toBe("heartbeat_run");
    expect(resolveHeartbeatObservabilitySurface(null)).toBe("heartbeat_run");
  });

  it("formats issue trace names with title and id", () => {
    expect(buildIssueRunTraceName({
      issueTitle: "Fix Langfuse trace naming",
      issueId: "issue-123",
    })).toBe("issue_run:Fix Langfuse trace naming [issue-123]");
  });

  it("normalizes whitespace and falls back when title is missing", () => {
    expect(buildIssueRunTraceName({
      issueTitle: "  Fix   Langfuse \n trace naming  ",
      issueId: "issue-123",
    })).toBe("issue_run:Fix Langfuse trace naming [issue-123]");
    expect(buildIssueRunTraceName({
      issueTitle: "",
      issueId: "issue-123",
    })).toBe("issue_run:[issue-123]");
  });

  it("builds runtime trace metadata with loaded skills and invocation details", () => {
    expect(buildHeartbeatRuntimeTraceMetadata({
      runtimeConfig: {
        instructionsFilePath: "/tmp/agent-instructions.md",
      },
      runtimeSkills: [
        {
          key: "langfuse",
          runtimeName: "langfuse",
          source: "/tmp/skills/langfuse",
          name: "Langfuse",
          description: "Trace and eval instrumentation",
        },
        {
          key: "checks",
          runtimeName: "checks",
          source: "/tmp/skills/checks",
          name: "Checks",
          description: "Verification helpers",
        },
      ],
      adapterMeta: {
        agentRuntimeType: "codex_local",
        command: "codex",
        cwd: "/tmp/run-workspace",
        commandNotes: ["Loaded agent instructions from /tmp/agent-instructions.md"],
        promptMetrics: {
          promptChars: 2048,
        },
      },
    })).toEqual({
      instructionsConfigured: true,
      instructionsFilePath: "/tmp/agent-instructions.md",
      loadedSkillCount: 2,
      loadedSkillKeys: ["langfuse", "checks"],
      loadedSkills: [
        {
          key: "langfuse",
          runtimeName: "langfuse",
          name: "Langfuse",
          description: "Trace and eval instrumentation",
        },
        {
          key: "checks",
          runtimeName: "checks",
          name: "Checks",
          description: "Verification helpers",
        },
      ],
      runtimeAgentType: "codex_local",
      runtimeCommand: "codex",
      runtimeCwd: "/tmp/run-workspace",
      runtimeCommandNotes: ["Loaded agent instructions from /tmp/agent-instructions.md"],
      runtimePromptMetrics: {
        promptChars: 2048,
      },
    });
  });

  it("adds prepared runtime skills to adapter invoke event payloads", () => {
    expect(buildHeartbeatAdapterInvokePayload({
      meta: {
        agentRuntimeType: "claude_local",
        command: "claude",
        cwd: "/tmp/run-workspace",
        commandArgs: ["--print"],
        commandNotes: ["Claude Code run"],
        promptMetrics: {
          promptChars: 1024,
        },
      },
      runtimeSkills: [
        {
          key: "rudder/build-advisor",
          runtimeName: "build-advisor",
          name: "Build Advisor",
          description: "Diagnose build quality",
        },
        {
          key: "rudder/screenshot",
          runtimeName: "screenshot",
          name: "Screenshot",
          description: null,
        },
      ],
    })).toEqual({
      agentRuntimeType: "claude_local",
      command: "claude",
      cwd: "/tmp/run-workspace",
      commandArgs: ["--print"],
      commandNotes: ["Claude Code run"],
      promptMetrics: {
        promptChars: 1024,
      },
      loadedSkillCount: 2,
      loadedSkillKeys: ["rudder/build-advisor", "rudder/screenshot"],
      loadedSkills: [
        {
          key: "rudder/build-advisor",
          runtimeName: "build-advisor",
          name: "Build Advisor",
          description: "Diagnose build quality",
        },
        {
          key: "rudder/screenshot",
          runtimeName: "screenshot",
          name: "Screenshot",
          description: null,
        },
      ],
    });
  });
});
