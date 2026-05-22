import type { HeartbeatRun } from "@rudderhq/shared";
import { stripBenignStderr } from "./benign-stderr";

type RunStderrExcerptInput = Pick<HeartbeatRun, "status" | "stderrExcerpt">;
type RunFailureInput = Pick<HeartbeatRun, "error" | "errorCode">;

const WORKSPACE_PERMISSION_REPAIR_NEEDED_CODE = "workspace_permission_repair_needed";

export function getRunStderrExcerptDisplayText(run: RunStderrExcerptInput): string {
  return stripBenignStderr(run.stderrExcerpt ?? "");
}

export function shouldShowRunStderrExcerpt(run: RunStderrExcerptInput): boolean {
  if (!getRunStderrExcerptDisplayText(run)) return false;
  return run.status === "failed" || run.status === "timed_out";
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
      body: run.error ?? "Rudder could not verify write access to its managed agent workspace before starting the run.",
      code: run.errorCode,
      actionLabel: "Open instance details",
      actionPath: "/instance/settings/about",
    };
  }
  return {
    title: "Run failed",
    body: run.error ?? run.errorCode ?? "Run exited with an error.",
    code: run.errorCode,
  };
}
