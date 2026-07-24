import { cp, mkdir, stat } from "node:fs/promises";
import path from "node:path";

export async function copyRuntimePostgresPayloadLibraries(
  sourceRuntimeDir: string,
  targetRuntimeDir: string,
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
}
