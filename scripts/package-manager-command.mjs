export function pnpmCommand(platform = process.platform) {
  return platform === "win32" ? "pnpm.cmd" : "pnpm";
}

export function pnpmSpawnShell(platform = process.platform) {
  return platform === "win32";
}
