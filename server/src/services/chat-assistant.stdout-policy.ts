import { createHash } from "node:crypto";
import { projectPrimaryRuntimeConfig } from "./runtime-kernel/model-fallback.js";
import { bindRuntimeExecutionConfig } from "./runtime-kernel/runtime-driver.js";

export function qualifiedChatCodexStdoutPolicy(input: {
  runtimeType: string;
  retentionMode: string;
  runId: string;
  orgId: string;
  config: Record<string, unknown>;
  providerBinding: NonNullable<Parameters<typeof bindRuntimeExecutionConfig>[1]>;
  bindingId: string;
}) {
  // Host-owned qualification, never a user config flag. Seal the exact
  // primary config after driver dispatch adds the admitted provider binding.
  return input.runtimeType === "codex_local" && input.retentionMode === "native"
    ? {
      mode: "native_retained",
      runtimeType: input.runtimeType,
      runId: input.runId,
      orgId: input.orgId,
      configSha256: createHash("sha256").update(JSON.stringify(
        bindRuntimeExecutionConfig(
          projectPrimaryRuntimeConfig(input.config, input.runtimeType),
          { ...input.providerBinding, id: input.bindingId },
        ),
      )).digest("hex"),
    }
    : null;
}
