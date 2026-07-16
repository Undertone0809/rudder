import { existsSync, readFileSync } from "node:fs";

export function assertDesktopUpdateMaintenanceAccess(input: {
  lockPath: string;
  instanceId: string;
  desktopUpdateId?: string;
}): void {
  if (!existsSync(input.lockPath)) return;

  let updateId: string | null = null;
  try {
    const parsed = JSON.parse(readFileSync(input.lockPath, "utf8")) as { updateId?: unknown };
    updateId = typeof parsed.updateId === "string" ? parsed.updateId : null;
  } catch {
    // An unreadable maintenance lock is still authoritative and fails closed.
  }
  if (!updateId || input.desktopUpdateId !== updateId) {
    throw new Error(
      `Local instance '${input.instanceId}' is locked while Rudder finishes Desktop update recovery.`,
    );
  }
}
