import path from "node:path";
import { resolveOrganizationStorageKey } from "../../../packages/agent-runtime-utils/src/organization-storage.ts";
import { E2E_HOME, E2E_INSTANCE_ID } from "./e2e-env";

export function resolveE2EOrganizationWorkspaceRoot(orgId: string) {
  return path.join(
    E2E_HOME,
    "instances",
    E2E_INSTANCE_ID,
    "organizations",
    resolveOrganizationStorageKey(orgId),
    "workspaces",
  );
}
