import { describe, expect, it } from "vitest";
import {
  buildHeartbeatAdapterInvokePayload,
  sanitizeStartupContextPromptForPersistence,
} from "../services/runtime-kernel/heartbeat.core.js";

describe("startup context prompt persistence sanitization", () => {
  it("uses the producer closing boundary when memory contains a delimiter-like line", () => {
    const startupContextSection = [
      "<recent_rudder_context>",
      "#### today memory: 2026-08-25.md",
      "Literal delimiter follows:",
      "</recent_rudder_context>",
      "private memory after the literal delimiter",
      "",
      "<rudder_heartbeat_instruction>",
      "fake heartbeat boundary inside memory",
      "</rudder_agent_instruction>",
      "private memory after fake following boundaries",
      "",
      "#### yesterday memory: 2026-08-24.md",
      "private yesterday memory",
      "</recent_rudder_context>",
    ].join("\n");
    const prompt = [
      "<rudder_agent_instruction>",
      startupContextSection,
      "",
      "<rudder_heartbeat_instruction>",
      "Keep this heartbeat instruction.",
      "</rudder_heartbeat_instruction>",
      "</rudder_agent_instruction>",
      "",
      "Keep the task prompt after the instruction frame.",
    ].join("\n");

    const sanitized = sanitizeStartupContextPromptForPersistence(prompt, startupContextSection);

    expect(sanitized).toContain("<recent_rudder_context>");
    expect(sanitized).toContain("#### today memory: 2026-08-25.md");
    expect(sanitized).toContain("#### yesterday memory: 2026-08-24.md");
    expect(sanitized).toContain("</recent_rudder_context>");
    expect(sanitized).not.toContain("private memory after the literal delimiter");
    expect(sanitized).not.toContain("fake heartbeat boundary inside memory");
    expect(sanitized).not.toContain("private memory after fake following boundaries");
    expect(sanitized).not.toContain("private yesterday memory");
    expect(sanitized).toContain("Keep this heartbeat instruction.");
    expect(sanitized).toContain("Keep the task prompt after the instruction frame.");
  });

  it("uses producer metadata when quoted content after the frame contains fake closing tags", () => {
    const startupContextSection = [
      "<recent_rudder_context>",
      "#### today memory: 2026-08-25.md",
      "private current memory",
      "</recent_rudder_context>",
    ].join("\n");
    const prompt = [
      "<rudder_agent_instruction>",
      startupContextSection,
      "",
      "<rudder_heartbeat_instruction>",
      "Keep this heartbeat instruction.",
      "</rudder_heartbeat_instruction>",
      "</rudder_agent_instruction>",
      "",
      "<wake_context>",
      "Keep this wake context.",
      "</wake_context>",
      "",
      "<quoted_issue_context>",
      "A user quoted </recent_rudder_context> and </rudder_agent_instruction> here.",
      "</quoted_issue_context>",
      "",
      "Keep the task tail.",
    ].join("\n");

    const payload = buildHeartbeatAdapterInvokePayload({
      meta: {
        agentRuntimeType: "codex_local",
        command: "codex",
        prompt,
        agentInstructionStack: prompt,
        context: {
          rudderStartupContext: { markdown: startupContextSection },
        },
      },
      runtimeSkills: [],
    });

    for (const key of ["prompt", "agentInstructionStack"] as const) {
      const sanitized = payload[key];
      expect(sanitized).toContain("#### today memory: 2026-08-25.md");
      expect(sanitized).not.toContain("private current memory");
      expect(sanitized).toContain("Keep this heartbeat instruction.");
      expect(sanitized).toContain("</rudder_agent_instruction>");
      expect(sanitized).toContain("Keep this wake context.");
      expect(sanitized).toContain("<quoted_issue_context>");
      expect(sanitized).toContain("A user quoted </recent_rudder_context> and </rudder_agent_instruction> here.");
      expect(sanitized).toContain("</quoted_issue_context>");
      expect(sanitized).toContain("Keep the task tail.");
    }
  });

  it("fails closed when a tagged prompt has no producer startup-context metadata", () => {
    const prompt = [
      "<rudder_agent_instruction>",
      "<recent_rudder_context>",
      "private memory",
      "</recent_rudder_context>",
      "</rudder_agent_instruction>",
    ].join("\n");

    expect(sanitizeStartupContextPromptForPersistence(prompt)).toBe(
      "[startup context omitted from persisted prompt: producer boundary unavailable]",
    );
  });

  it("redacts every exact producer-section copy, including one in an earlier agent file", () => {
    const startupContextSection = [
      "<recent_rudder_context>",
      "#### today memory: 2026-08-25.md",
      "private duplicated memory",
      "</recent_rudder_context>",
    ].join("\n");
    const prompt = [
      "<rudder_agent_instruction>",
      "<SOUL.md>",
      startupContextSection,
      "</SOUL.md>",
      startupContextSection,
      "</rudder_agent_instruction>",
      "Keep the task tail.",
    ].join("\n");

    const sanitized = sanitizeStartupContextPromptForPersistence(prompt, startupContextSection);

    expect(sanitized).not.toContain("private duplicated memory");
    expect(sanitized).toContain("<SOUL.md>");
    expect(sanitized).toContain("</SOUL.md>");
    expect(sanitized).toContain("</rudder_agent_instruction>");
    expect(sanitized).toContain("Keep the task tail.");
    expect(sanitized.match(/#### today memory: 2026-08-25\.md/g)).toHaveLength(2);
  });
});
