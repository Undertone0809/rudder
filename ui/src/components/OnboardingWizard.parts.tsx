import {
  type Organization
} from "@rudderhq/shared";

export type Step = 1 | 2 | 3 | 4;
export type AdapterType =
  | "claude_local"
  | "codex_local"
  | "gemini_local"
  | "opencode_local"
  | "pi_local"
  | "cursor"
  | "http"
  | "openclaw_gateway";

export const DEFAULT_FIRST_AGENT_TITLE = "Operator Assistant";

export const DEFAULT_TASK_TITLE = "Start your first real work loop";

export const DEFAULT_TASK_DESCRIPTION = `Help the operator start the first real work loop.

- review the organization goal
- identify one bounded issue the operator wants to move
- make the issue clear enough to assign
- run or route the work when ready
- leave evidence, validation, and the next review step`;

export const ONBOARDING_PROJECT_NAME = "Getting Started";
export const ONBOARDING_DRAFT_ORGANIZATION_STORAGE_KEY =
  "rudder.onboardingDraftOrganizationId";

export function upsertOrganization(
  current: Organization[] | undefined,
  organization: Organization,
): Organization[] {
  if (!current || current.length === 0) {
    return [organization];
  }
  const existingIndex = current.findIndex((entry) => entry.id === organization.id);
  if (existingIndex < 0) {
    return [...current, organization];
  }
  return current.map((entry) => (entry.id === organization.id ? organization : entry));
}
