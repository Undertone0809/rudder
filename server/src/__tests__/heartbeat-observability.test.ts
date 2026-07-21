import { describe, expect, it } from "vitest";
import {
  buildHeartbeatAdapterInvokePayload,
  detectForbiddenRuntimeSkillMarker,
  resolveForbiddenRuntimeSkillMarkers,
} from "../services/heartbeat.js";

describe("heartbeat execution event observability", () => {
  it("records adapter invocation metadata and prepared runtime skills", () => {
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
      loadedSkillCount: 1,
      loadedSkillKeys: ["rudder/build-advisor"],
      desiredSkillCount: 1,
      desiredSkillKeys: ["rudder/build-advisor"],
      loadedSkillEvidenceType: "legacy_availability",
      skillEvidenceType: "loaded",
    });
  });

  it("redacts inline visual source from persisted adapter prompts", () => {
    const payload = buildHeartbeatAdapterInvokePayload({
      meta: {
        agentRuntimeType: "process",
        command: "agent-process",
        prompt: [
          "Repair this reply:",
          ":::rudder-inline-visual:v1",
          '<div id="widget">PRIVATE_PERSISTED_PROMPT</div>',
          ":::rudder-inline-visual:end",
          "Keep this sentence.",
        ].join("\n"),
      },
      runtimeSkills: [],
    });

    expect(payload.prompt).toBe("Repair this reply:\nKeep this sentence.");
    expect(JSON.stringify(payload)).not.toContain("PRIVATE_PERSISTED_PROMPT");
    expect(JSON.stringify(payload)).not.toContain(":::rudder-inline-visual");
    expect(payload.promptSanitizedForPersistence).toBe(true);
  });

  it("persists forbidden runtime skill evidence from adapter results", () => {
    const markers = resolveForbiddenRuntimeSkillMarkers({
      runtimeSkillIsolation: {
        forbiddenMarkers: [
          "RUDDER_FORBIDDEN_GLOBAL_SKILL",
          " ",
          "RUDDER_FORBIDDEN_GLOBAL_SKILL",
        ],
      },
    });

    expect(markers).toEqual(["RUDDER_FORBIDDEN_GLOBAL_SKILL"]);
    expect(detectForbiddenRuntimeSkillMarker({
      markers,
      meta: {
        agentRuntimeType: "codex_local",
        command: "codex",
        forbiddenMarkerObserved: false,
      },
      stdoutExcerpt: "adapter completed",
      stderrExcerpt: "",
      resultJson: {
        summary: "Observed RUDDER_FORBIDDEN_GLOBAL_SKILL in the result",
      },
      transcript: [],
    })).toEqual({
      observed: true,
      evidence: [
        {
          marker: "RUDDER_FORBIDDEN_GLOBAL_SKILL",
          source: "resultJson",
        },
      ],
    });
  });
});
