import { spawnSync } from "node:child_process";

export function extractRuntimePostgresArchiveNode(archivePath: string, extractDir: string): void {
  const result = process.platform === "win32"
    ? spawnSync("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
        "$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath $env:PG_ARCHIVE_PATH -DestinationPath $env:PG_EXTRACT_DIR -Force",
      ], {
        encoding: "utf8",
        env: { ...process.env, PG_ARCHIVE_PATH: archivePath, PG_EXTRACT_DIR: extractDir },
        windowsHide: true,
      })
    : spawnSync("tar", ["-xf", archivePath, "-C", extractDir], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`failed to extract PostgreSQL archive: ${result.stderr || result.stdout}`);
}
