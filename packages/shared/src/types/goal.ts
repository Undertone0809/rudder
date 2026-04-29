import type { GoalLevel, GoalStatus } from "../constants.js";

export interface Goal {
  id: string;
  orgId: string;
  title: string;
  description: string | null;
  level: GoalLevel;
  status: GoalStatus;
  parentId: string | null;
  ownerAgentId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface GoalDependencyPreview {
  id: string;
  title: string;
  subtitle?: string | null;
}

export interface GoalDependencies {
  goalId: string;
  orgId: string;
  canDelete: boolean;
  blockers: string[];
  isLastRootOrganizationGoal: boolean;
  counts: {
    childGoals: number;
    linkedProjects: number;
    linkedIssues: number;
    automations: number;
    costEvents: number;
    financeEvents: number;
  };
  previews: {
    childGoals: GoalDependencyPreview[];
    linkedProjects: GoalDependencyPreview[];
    linkedIssues: GoalDependencyPreview[];
    automations: GoalDependencyPreview[];
  };
}
