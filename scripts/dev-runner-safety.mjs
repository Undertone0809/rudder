export function assertDevRuntimeTakeoverAllowed(probe, expected) {
  const localEnv = expected.localEnv?.trim().toLowerCase().replace(/-/g, "_");
  const instanceId = expected.instanceId?.trim();
  if (localEnv === "prod_local" || instanceId === "default") {
    throw new Error(
      `Refusing to start pnpm dev against protected production target ` +
        `${expected.localEnv} instance '${expected.instanceId}'. ` +
        "Use an isolated dev instance instead.",
    );
  }

  if (probe.kind !== "healthy") return;

  const runtimeOwnerKind = probe.health.runtimeOwnerKind ?? probe.descriptor.ownerKind;
  if (runtimeOwnerKind === "dev_runner") return;

  throw new Error(
    `Refusing to take over ${expected.localEnv} instance '${expected.instanceId}' from ` +
      `${runtimeOwnerKind ?? "an unknown owner"} runtime pid ${probe.descriptor.pid}. ` +
      "pnpm dev may only replace an existing dev_runner runtime.",
  );
}
