import type { HeartbeatRun } from "@rudderhq/shared";
import { stripBenignStderr } from "./benign-stderr";

type RunStderrExcerptInput = Pick<HeartbeatRun, "status" | "stderrExcerpt">;
type RunFailureInput = Pick<HeartbeatRun, "error" | "errorCode">;

const WORKSPACE_PERMISSION_REPAIR_NEEDED_CODE = "workspace_permission_repair_needed";
export const GENERIC_RUN_FAILURE_BODY =
  "The run hit a system-level execution problem. Rudder saved the technical details for diagnostics.";

export function getRunStderrExcerptDisplayText(run: RunStderrExcerptInput): string {
  return stripBenignStderr(run.stderrExcerpt ?? "");
}

export function shouldShowRunStderrExcerpt(run: RunStderrExcerptInput): boolean {
  void run;
  return false;
}

export function isWorkspacePermissionRepairRun(run: RunFailureInput): boolean {
  return run.errorCode === WORKSPACE_PERMISSION_REPAIR_NEEDED_CODE;
}

export function getRunFailureDisplay(run: RunFailureInput): {
  title: string;
  body: string;
  code: string | null;
  actionLabel?: string;
  actionPath?: string;
} | null {
  if (!run.error && !run.errorCode) return null;
  if (isWorkspacePermissionRepairRun(run)) {
    return {
      title: "Workspace permission repair needed",
      body: "Rudder could not verify write access to its managed agent workspace before starting the run.",
      code: run.errorCode,
      actionLabel: "Open instance details",
      actionPath: "/instance/settings/about",
    };
  }
  return {
    title: "Run failed",
    body: GENERIC_RUN_FAILURE_BODY,
    code: run.errorCode,
  };
}
