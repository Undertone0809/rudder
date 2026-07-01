import { describe, expect, it } from "vitest";
import {
  buildHeartbeatAdapterInvokePayload,
  buildHeartbeatRuntimeTraceMetadata,
  buildIssueRunTraceName,
  detectForbiddenRuntimeSkillMarker,
  inferUsedSkillsFromTranscript,
  resolveForbiddenRuntimeSkillMarkers,
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
    })).toMatchObject({
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
      loadedSkillEvidenceType: "legacy_availability",
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
      desiredSkillCount: 2,
      desiredSkillKeys: ["rudder/build-advisor", "rudder/screenshot"],
      realizedSkillCount: 0,
      realizedSkillKeys: [],
      nativeDiscoverableSkillCount: 0,
      nativeDiscoverableSkillKeys: [],
      promptInjectedSkillCount: 0,
      promptInjectedSkillKeys: [],
      usedSkillCount: 0,
      usedSkillKeys: [],
      usedSkills: [],
      promptRequestedSkillCount: 0,
      promptRequestedSkillKeys: [],
      promptRequestedSkills: [],
      skillEvidenceType: "loaded",
      skillEvidenceCount: 0,
      skillEvidenceKeys: [],
      skillEvidenceSkills: [],
    });
  });

  it("preserves runtime-reported loaded skills when they differ from prepared skills", () => {
    expect(buildHeartbeatAdapterInvokePayload({
      meta: {
        agentRuntimeType: "opencode_local",
        command: "opencode",
        loadedSkills: [
          {
            key: "rudder/build-advisor",
            runtimeName: "build-advisor",
            name: "Build Advisor",
            description: "Diagnose build quality",
          },
        ],
      },
      runtimeSkills: [],
    })).toMatchObject({
      loadedSkillCount: 1,
      loadedSkillKeys: ["rudder/build-advisor"],
      loadedSkills: [
        {
          key: "rudder/build-advisor",
          runtimeName: "build-advisor",
          name: "Build Advisor",
          description: "Diagnose build quality",
        },
      ],
      realizedSkillCount: 0,
      realizedSkillKeys: [],
      loadedSkillEvidenceType: "legacy_availability",
      skillEvidenceType: "loaded",
      skillEvidenceKeys: [],
    });
  });

  it("separates desired, realized, native, prompt-injected, and used skill evidence", () => {
    expect(buildHeartbeatAdapterInvokePayload({
      meta: {
        agentRuntimeType: "cursor",
        command: "cursor-agent",
        realizedSkills: [
          {
            key: "rudder/build-advisor",
            runtimeName: "build-advisor",
            name: "Build Advisor",
          },
        ],
        promptInjectedSkills: [
          {
            key: "rudder/build-advisor",
            runtimeName: "build-advisor",
            name: "Build Advisor",
          },
        ],
        nativeDiscoverableSkills: [],
        usedSkills: [
          {
            key: "rudder/build-advisor",
            runtimeName: "build-advisor",
            name: "Build Advisor",
          },
        ],
        forbiddenMarkerObserved: false,
      },
      runtimeSkills: [
        {
          key: "rudder/build-advisor",
          runtimeName: "build-advisor",
          name: "Build Advisor",
          description: "Diagnose build quality",
        },
      ],
    })).toMatchObject({
      desiredSkillCount: 1,
      desiredSkillKeys: ["rudder/build-advisor"],
      realizedSkillCount: 1,
      realizedSkillKeys: ["rudder/build-advisor"],
      nativeDiscoverableSkillCount: 0,
      nativeDiscoverableSkillKeys: [],
      promptInjectedSkillCount: 1,
      promptInjectedSkillKeys: ["rudder/build-advisor"],
      usedSkillCount: 1,
      usedSkillKeys: ["rudder/build-advisor"],
      forbiddenMarkerObserved: false,
      skillEvidenceType: "used",
      skillEvidenceKeys: ["rudder/build-advisor"],
    });
  });

  it("infers used skills from provider skill tool calls", () => {
    expect(inferUsedSkillsFromTranscript([
      {
        kind: "tool_call",
        ts: "2026-05-30T10:00:00.000Z",
        name: "Skill",
        toolUseId: "skill-1",
        input: { skill: "rudder-create-agent", args: "create COO agent" },
      },
      {
        kind: "tool_call",
        ts: "2026-05-30T10:00:01.000Z",
        name: "skill",
        toolUseId: "skill-2",
        input: { skillName: "build-advisor" },
      },
      {
        kind: "tool_call",
        ts: "2026-05-30T10:00:01.500Z",
        name: "activate_skill",
        toolUseId: "skill-3",
        input: { name: "gemini-telemetry-sentinel" },
      },
      {
        kind: "tool_call",
        ts: "2026-05-30T10:00:02.000Z",
        name: "read_file",
        toolUseId: "read-1",
        input: { path: "/workspace/.agents/skills/mcp-chrome-global/SKILL.md" },
      },
      {
        kind: "tool_call",
        ts: "2026-05-30T10:00:03.000Z",
        name: "functions.exec_command",
        toolUseId: "exec-1",
        input: {
          cmd: `sed -n '1,260p' "'$AGENT_HOME/skills/agent-work-reviewer-maintainer/SKILL.md"`,
        },
      },
    ])).toEqual([
      { key: "rudder-create-agent", label: "rudder-create-agent" },
      { key: "build-advisor", label: "build-advisor" },
      { key: "gemini-telemetry-sentinel", label: "gemini-telemetry-sentinel" },
      { key: "mcp-chrome-global", label: "mcp-chrome-global" },
      { key: "agent-work-reviewer-maintainer", label: "agent-work-reviewer-maintainer" },
    ]);
  });

  it("separates prompt-requested skills from runtime-reported used skills", () => {
    expect(buildHeartbeatAdapterInvokePayload({
      meta: {
        agentRuntimeType: "codex_local",
        command: "codex",
        prompt: "Please use [$build-advisor](/workspace/.agents/skills/build-advisor/SKILL.md).",
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
    })).toMatchObject({
      usedSkillCount: 0,
      usedSkillKeys: [],
      usedSkills: [],
      promptRequestedSkillCount: 1,
      promptRequestedSkillKeys: ["rudder/build-advisor"],
      promptRequestedSkills: [
        {
          key: "rudder/build-advisor",
          label: "build-advisor",
        },
      ],
      skillEvidenceType: "requested",
      skillEvidenceCount: 1,
      skillEvidenceKeys: ["rudder/build-advisor"],
      skillEvidenceSkills: [
        {
          key: "rudder/build-advisor",
          label: "build-advisor",
        },
      ],
    });
  });

  it("keeps the full agent instruction stack visible while sanitizing legacy prompt persistence", () => {
    const payload = buildHeartbeatAdapterInvokePayload({
      meta: {
        agentRuntimeType: "pi_local",
        command: "pi",
        prompt: [
          "# Rudder Agent Operating Contract",
          "",
          "## Recent Rudder Context",
          "",
          "#### today memory: 2026-06-21.md",
          "",
          "- private startup detail",
          "",
          "## Current Time",
          "",
          "Instruction load time: 2026-06-21T05:50:43.024Z.",
        ].join("\n"),
        agentInstructionStack: [
          "# Rudder Agent Operating Contract",
          "",
          "# SOUL.md",
          "",
          "## Recent Rudder Context",
          "",
          "#### today memory: 2026-06-21.md",
          "",
          "- private startup detail",
          "",
          "## Current Time",
          "",
          "# Rudder Heartbeat Instruction",
        ].join("\n"),
      },
      runtimeSkills: [],
    });

    expect(payload.prompt).toContain("#### today memory: 2026-06-21.md");
    expect(payload.prompt).not.toContain("[startup context omitted from persisted prompt]");
    expect(payload.prompt).not.toContain("- private startup detail");
    expect(payload.agentInstructionStack).toContain("# SOUL.md");
    expect(payload.agentInstructionStack).not.toContain("## Agent Instruction:");
    expect(payload.agentInstructionStack).toContain("#### today memory: 2026-06-21.md");
    expect(payload.agentInstructionStack).not.toContain("[startup context omitted from persisted prompt]");
    expect(payload.agentInstructionStack).not.toContain("- private startup detail");
  });

  it("preserves explicit runtime-reported used skills as strongest evidence", () => {
    expect(buildHeartbeatAdapterInvokePayload({
      meta: {
        agentRuntimeType: "codex_local",
        command: "codex",
        prompt: "Please use [$build-advisor](/workspace/.agents/skills/build-advisor/SKILL.md).",
        usedSkills: [
          {
            key: "rudder/screenshot",
            runtimeName: "screenshot",
            name: "Screenshot",
          },
        ],
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
    })).toMatchObject({
      usedSkillCount: 1,
      usedSkillKeys: ["rudder/screenshot"],
      promptRequestedSkillKeys: ["rudder/build-advisor"],
      skillEvidenceType: "used",
      skillEvidenceKeys: ["rudder/screenshot"],
    });
  });

  it("resolves forbidden runtime skill markers from runtime isolation config", () => {
    expect(resolveForbiddenRuntimeSkillMarkers({
      runtimeSkillIsolation: {
        forbiddenMarkers: [
          "ZST646_FORBIDDEN_GLOBAL_SKILL_LOADED",
          "  ",
          "ZST646_FORBIDDEN_GLOBAL_SKILL_LOADED",
        ],
      },
    })).toEqual(["ZST646_FORBIDDEN_GLOBAL_SKILL_LOADED"]);

    expect(resolveForbiddenRuntimeSkillMarkers({
      rudderSkillIsolation: {
        forbiddenMarker: "RUDDER_FORBIDDEN_GLOBAL_SKILL",
      },
    })).toEqual(["RUDDER_FORBIDDEN_GLOBAL_SKILL"]);
  });

  it("detects forbidden runtime skill markers across meta, logs, result, and transcript", () => {
    expect(detectForbiddenRuntimeSkillMarker({
      markers: ["ZST646_FORBIDDEN_GLOBAL_SKILL_LOADED"],
      meta: {
        agentRuntimeType: "codex_local",
        command: "codex",
        forbiddenMarkerObserved: false,
      },
      stdoutExcerpt: "positive probe ok",
      stderrExcerpt: "",
      resultJson: {
        summary: "A disabled skill said ZST646_FORBIDDEN_GLOBAL_SKILL_LOADED",
      },
      transcript: [
        {
          kind: "stdout",
          ts: "2026-06-20T00:00:00.000Z",
          text: "no marker here",
        },
      ],
    })).toEqual({
      observed: true,
      evidence: [
        {
          marker: "ZST646_FORBIDDEN_GLOBAL_SKILL_LOADED",
          source: "resultJson",
        },
      ],
    });
  });

  it("detects forbidden runtime skill markers inside deeply nested OpenCode result payloads", () => {
    const marker = "ZST646_FORBIDDEN_OPENCODE_NATIVE_SKILL";

    expect(detectForbiddenRuntimeSkillMarker({
      markers: [marker],
      meta: {
        agentRuntimeType: "opencode_local",
        command: "opencode",
        forbiddenMarkerObserved: false,
      },
      stdoutExcerpt: "opencode completed",
      stderrExcerpt: "",
      resultJson: {
        output: {
          steps: [
            {
              message: {
                content: [
                  {
                    toolUse: {
                      name: "skill",
                      result: {
                        metadata: {
                          display: {
                            text: `loaded forbidden native skill ${marker}`,
                          },
                        },
                      },
                    },
                  },
                ],
              },
            },
          ],
        },
      },
      transcript: [],
    })).toEqual({
      observed: true,
      evidence: [
        {
          marker,
          source: "resultJson",
        },
      ],
    });
  });

  it("keeps adapter-reported forbidden marker observations even without configured marker strings", () => {
    expect(detectForbiddenRuntimeSkillMarker({
      markers: [],
      meta: {
        agentRuntimeType: "claude_local",
        command: "claude",
        forbiddenMarkerObserved: true,
      },
      stdoutExcerpt: "",
      stderrExcerpt: "",
      resultJson: null,
      transcript: [],
    })).toEqual({
      observed: true,
      evidence: [
        {
          marker: null,
          source: "adapter_meta",
        },
      ],
    });
  });
});
