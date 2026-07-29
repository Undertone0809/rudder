import { cp, mkdir, stat } from "node:fs/promises";
import path from "node:path";

export async function copyRuntimePostgresPayload(
  sourceRuntimeDir: string,
  targetRuntimeDir: string,
  sourceShareDir = path.join(sourceRuntimeDir, "share"),
): Promise<void> {
  await mkdir(targetRuntimeDir, { recursive: true });
  for (const directoryName of ["bin", "lib"]) {
    const sourceDirectory = path.join(sourceRuntimeDir, directoryName);
    if (!await stat(sourceDirectory).catch(() => null)) continue;
    await cp(
      sourceDirectory,
      path.join(targetRuntimeDir, directoryName),
      { recursive: true, dereference: true },
    );
  }
  await cp(
    sourceShareDir,
    path.join(targetRuntimeDir, "share"),
    { recursive: true, dereference: true },
  );
}
