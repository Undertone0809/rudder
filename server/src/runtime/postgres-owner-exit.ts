import type { RuntimeSupervisor } from "./runtime-supervisor.js";

export function disposeAfterPostgresOwnerExit(
  supervisor: RuntimeSupervisor,
  onCleanupFailure: (error: unknown) => void,
): void {
  void supervisor.dispose().catch((error: unknown) => {
    try {
      onCleanupFailure(error);
    } catch {
      // A logging failure must not create another detached rejection.
    }
  });
}
