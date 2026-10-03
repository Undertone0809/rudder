import type { Db } from "@rudderhq/db";
import { shouldStartAutomaticBackupSchedulers } from "../backup-scheduler-policy.js";
import { startRuntimeRetentionMaintenance } from "../services/runtime-kernel/runtime-retention.js";

export function startBackupSchedulersWithRuntimeRetention(input: {
  localEnv: string | null | undefined;
  db: Db;
  intervalMs: number;
  logger: { error(fields: { err: unknown }, message: string): void };
  supervisor: { own(name: string, dispose: () => void): void };
}) {
  if (!shouldStartAutomaticBackupSchedulers(input.localEnv)) return false;
  const maintenance = startRuntimeRetentionMaintenance(input.db, {
    intervalMs: input.intervalMs,
    onError: (error) => input.logger.error({ err: error }, "Scheduled runtime retention maintenance failed"),
  });
  input.supervisor.own("runtime-retention-maintenance", () => maintenance.stop());
  return true;
}
