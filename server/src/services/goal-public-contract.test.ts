import { describe, expect, it } from "vitest";
import { publicGoalContractSummary, publicGoalText } from "./goal-public-contract.js";

describe("public Goal contract helpers", () => {
  it("removes internal terms and opaque references from public text", () => {
    expect(publicGoalText(
      "Goal contract evidence demonstrates that runtime evidence is linked to goal-feedback:85d206b4-6e1f-4f24-9d98-76e3c0f3d1a2.",
    )).toBe("Goal Supporting work shows that supporting evidence is linked to the related update.");
  });

  it("summarizes only public outcome, criteria, boundaries, authority, and completion rules", () => {
    expect(publicGoalContractSummary({
      outcomeStatement: "Complete the contract",
      criteria: [{ label: "Evidence demonstrates that the result exists" }, { label: "  " }, null],
      evaluationDeadline: "2026-10-01T00:00:00.000Z",
      actionDeadline: "ignored-fallback",
      autonomyEnvelope: {
        allowed: ["bounded_reversible_work", 42],
        requiresHumanApproval: ["external_publication"],
      },
      humanAuthorities: {
        consequentialChanges: "board_human",
        externalPublication: false,
      },
      evaluationPolicy: {
        terminalEvidenceRequired: true,
        humanAcceptanceRequired: true,
      },
      privateField: "not surfaced",
    })).toEqual({
      outcomeStatement: "Complete the agreement",
      criteria: [{ label: "Supporting work shows that the result exists" }],
      targetTime: "2026-10-01T00:00:00.000Z",
      boundarySummary: "The Agent may handle bounded, reversible work. You will be asked before publishing externally.",
      approvalSummary: "You decide consequential changes.",
      completionSummary: "Supporting work is shown, and you accept the result.",
    });
  });

  it("omits empty or invalid public contract details", () => {
    expect(publicGoalContractSummary({
      outcomeStatement: "  ",
      criteria: [null, { label: " " }],
      autonomyEnvelope: { allowed: [], requiresHumanApproval: [null] },
      humanAuthorities: { blocked: false },
      evaluationPolicy: { terminalEvidenceRequired: 1, humanAcceptanceRequired: false },
    })).toEqual({});
  });
});
