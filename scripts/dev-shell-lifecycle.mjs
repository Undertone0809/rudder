export function classifyDevServerExit({ runtimeOwnerKind, shuttingDown }) {
  if (shuttingDown) return "ignore";
  return runtimeOwnerKind === "desktop" ? "desktop-managed" : "fatal";
}

export function classifyDevDesktopExit({ desktopOwnsRuntime, shuttingDown }) {
  if (shuttingDown) return "ignore";
  return desktopOwnsRuntime ? "exit-parent" : "runtime-still-running";
}

export async function stopManagedDevShellChildren(children, timeoutMs = 10_000) {
  const waits = [];
  for (const child of children) {
    if (!child || child.killed) continue;
    waits.push(new Promise((resolve) => {
      child.once("exit", resolve);
      child.kill("SIGTERM");
      if (child.exitCode !== null || child.signalCode !== null) resolve();
    }));
  }
  if (waits.length === 0) return;
  await Promise.race([
    Promise.allSettled(waits),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}
