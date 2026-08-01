export function classifyDevServerExit({ runtimeOwnerKind, shuttingDown }) {
  if (shuttingDown) return "ignore";
  return runtimeOwnerKind === "desktop" ? "desktop-managed" : "fatal";
}

export function classifyDevDesktopExit({ desktopOwnsRuntime, shuttingDown }) {
  if (shuttingDown) return "ignore";
  return desktopOwnsRuntime ? "exit-parent" : "runtime-still-running";
}
