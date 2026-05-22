import type { Issue, Project } from "@rudderhq/shared";
import { api } from "./client";

export interface GettingStartedSeedResult {
  project: Project;
  issues: Issue[];
  createdProject: boolean;
  createdIssueCount: number;
  includeTutorial: boolean;
}

export const onboardingApi = {
  seedGettingStarted: (orgId: string, options: { includeTutorial?: boolean } = {}) =>
    api.post<GettingStartedSeedResult>(
      `/orgs/${orgId}/onboarding/getting-started`,
      options,
    ),
};
