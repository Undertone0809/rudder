import { describe, expect, it } from "vitest";
import {
  resolveIssueGoalId,
  resolveNextIssueGoalId,
} from "../services/issue-goal-fallback.ts";

describe("issue goal fallback", () => {
  it("assigns the organization goal when creating an issue without project or goal", () => {
    expect(
      resolveIssueGoalId({
        projectId: null,
        goalId: undefined,
        defaultGoalId: "goal-1",
      }),
    ).toBe("goal-1");
  });

  it("honors an explicit goal clear when creating a projectless issue", () => {
    expect(
      resolveIssueGoalId({
        projectId: null,
        goalId: null,
        defaultGoalId: "goal-1",
      }),
    ).toBeNull();
  });

  it("keeps an explicit goal when creating an issue", () => {
    expect(
      resolveIssueGoalId({
        projectId: null,
        goalId: "goal-2",
        defaultGoalId: "goal-1",
      }),
    ).toBe("goal-2");
  });

  it("does not force a organization goal when the issue belongs to a project", () => {
    expect(
      resolveIssueGoalId({
        projectId: "project-1",
        goalId: null,
        defaultGoalId: "goal-1",
      }),
    ).toBeNull();
  });

  it("backfills the organization goal on update for legacy no-project issues", () => {
    expect(
      resolveNextIssueGoalId({
        currentProjectId: null,
        currentGoalId: null,
        defaultGoalId: "goal-1",
      }),
    ).toBe("goal-1");
  });

  it("honors an explicit goal clear on update instead of reapplying the organization fallback", () => {
    expect(
      resolveNextIssueGoalId({
        currentProjectId: null,
        currentGoalId: "goal-1",
        goalId: null,
        defaultGoalId: "goal-1",
      }),
    ).toBeNull();
  });

  it("clears the fallback when a project is added later", () => {
    expect(
      resolveNextIssueGoalId({
        currentProjectId: null,
        currentGoalId: "goal-1",
        projectId: "project-1",
        goalId: null,
        defaultGoalId: "goal-1",
      }),
    ).toBeNull();
  });
});
