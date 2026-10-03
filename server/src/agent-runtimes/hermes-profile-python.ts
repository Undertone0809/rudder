import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Read-only dependency detection; never import Hermes startup or provider config. */
export async function resolveHermesProfilePython(
  candidates: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ pythonCommand: string | null; gap?: "python_missing" | "yaml_missing" }> {
  let found = false;
  for (const candidate of candidates) {
    try {
      if (!path.isAbsolute(candidate) || !(await stat(candidate)).isFile()) continue;
      found = true;
      await execFileAsync(candidate, ["-I", "-c", "import yaml"], {
        ...options, timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 16 * 1024, windowsHide: true,
      });
      return { pythonCommand: candidate };
    } catch {
      // Automatic discovery can inspect the next installed environment. An
      // explicit override is represented by a single candidate, not replaced.
    }
  }
  return { pythonCommand: null, gap: found ? "yaml_missing" : "python_missing" };
}
