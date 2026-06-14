import { describe, expect, it } from "vitest";
import { extractSkillEvidenceMatch } from "../services/run-intelligence.ts";

describe("run intelligence skill evidence", () => {
  it("keeps used and loaded skill evidence distinct", () => {
    const usedMatch = extractSkillEvidenceMatch({
      evidenceType: "used",
      skillQuery: "skill-optimizer",
      eventType: "adapter.skill_usage",
      eventId: 11,
      eventCreatedAt: new Date("2026-06-11T10:01:00.000Z"),
      payload: {
        source: "transcript.skill_file_read",
        usedSkillKeys: ["skill-optimizer"],
        usedSkills: [
          { key: "skill-optimizer", label: "Skill Optimizer" },
        ],
        loadedSkillKeys: ["rudder/rudder"],
        loadedSkills: [
          { key: "rudder/rudder", label: "Rudder" },
        ],
      },
    });

    expect(usedMatch).toMatchObject({
      evidenceType: "used",
      matchedSkillKey: "skill-optimizer",
      matchedSkillLabel: "Skill Optimizer",
      sourceEventType: "adapter.skill_usage",
      sourceEventId: 11,
      sourceEventCreatedAt: "2026-06-11T10:01:00.000Z",
    });

    const loadedMatch = extractSkillEvidenceMatch({
      evidenceType: "loaded",
      skillQuery: "Rudder",
      eventType: "adapter.invoke",
      eventId: 12,
      eventCreatedAt: "2026-06-10T10:00:05.000Z",
      payload: {
        usedSkillKeys: ["skill-optimizer"],
        usedSkills: [
          { key: "skill-optimizer", label: "Skill Optimizer" },
        ],
        loadedSkillKeys: ["rudder/rudder"],
        loadedSkills: [
          { key: "rudder/rudder", label: "Rudder" },
        ],
      },
    });

    expect(loadedMatch).toMatchObject({
      evidenceType: "loaded",
      matchedSkillKey: "rudder/rudder",
      matchedSkillLabel: "Rudder",
      sourceEventType: "adapter.invoke",
      sourceEventId: 12,
      sourceEventCreatedAt: "2026-06-10T10:00:05.000Z",
    });
  });

  it("prefers structured skill labels over fallback key labels", () => {
    const match = extractSkillEvidenceMatch({
      evidenceType: "used",
      skillQuery: "Skill Optimizer",
      eventType: "adapter.skill_usage",
      eventId: 13,
      eventCreatedAt: null,
      payload: {
        usedSkillKeys: ["skill-optimizer"],
        usedSkills: [
          { key: "skill-optimizer", label: "Skill Optimizer" },
        ],
      },
    });

    expect(match).toMatchObject({
      matchedSkillKey: "skill-optimizer",
      matchedSkillLabel: "Skill Optimizer",
      sourceEventCreatedAt: null,
    });
  });
});
