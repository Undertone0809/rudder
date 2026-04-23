import { spawn } from "node:child_process";
import path from "node:path";

const PATH_START_MARKER = "__RUDDER_LOGIN_SHELL_PATH_START__";
const PATH_END_MARKER = "__RUDDER_LOGIN_SHELL_PATH_END__";
const DEFAULT_LOGIN_SHELL_TIMEOUT_MS = 4_000;

export type LoginShellEnvResult = {
  changed: boolean;
  shellPath: string | null;
  loginPath: string | null;
  mergedPath: string | null;
};

type ShellRunner = (
  shellPath: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
  },
) => Promise<{ stdout: string; stderr: string }>;

function pathKey(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function uniqueNonEmptyPaths(values: Iterable<string>, delimiter: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const rawValue of values) {
    for (const entry of rawValue.split(delimiter)) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      const key = pathKey(trimmed);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(trimmed);
    }
  }
  return result;
}

export function mergePathValues(
  currentPath: string | null | undefined,
  loginPath: string | null | undefined,
  delimiter: string = path.delimiter,
): string | null {
  const merged = uniqueNonEmptyPaths([currentPath ?? "", loginPath ?? ""], delimiter);
  return merged.length > 0 ? merged.join(delimiter) : null;
}

export function extractMarkedPath(output: string): string | null {
  const startIndex = output.indexOf(PATH_START_MARKER);
  if (startIndex === -1) return null;
  const searchFrom = startIndex + PATH_START_MARKER.length;
  const endIndex = output.indexOf(PATH_END_MARKER, searchFrom);
  if (endIndex === -1) return null;
  const raw = output.slice(searchFrom, endIndex).trim();
  return raw.length > 0 ? raw : null;
}

export function resolveLoginShellCandidates(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform === "win32") return [];

  const candidates: string[] = [];
  const pushCandidate = (value: string | null | undefined) => {
    const trimmed = value?.trim();
    if (!trimmed || !path.isAbsolute(trimmed)) return;
    if (candidates.includes(trimmed)) return;
    candidates.push(trimmed);
  };

  pushCandidate(env.SHELL);
  pushCandidate("/bin/zsh");
  pushCandidate("/bin/bash");
  pushCandidate("/bin/sh");
  return candidates;
}

async function defaultShellRunner(
  shellPath: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
  },
): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(shellPath, args, {
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    let stdout = "";
    let stderr = "";
    let finished = false;

    const timeout = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill("SIGTERM");
      reject(new Error(`Timed out reading login shell PATH from ${shellPath}`));
    }, options.timeoutMs);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      if (signal) {
        reject(new Error(`${shellPath} exited with signal ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`${shellPath} exited with code ${code ?? 1}: ${stderr.trim()}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

export async function readLoginShellPath(options: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  runner?: ShellRunner;
} = {}): Promise<{ shellPath: string | null; pathValue: string | null }> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOGIN_SHELL_TIMEOUT_MS;
  const runner = options.runner ?? defaultShellRunner;
  const candidates = resolveLoginShellCandidates(env, platform);
  const command = `printf '%s\n' '${PATH_START_MARKER}' "$PATH" '${PATH_END_MARKER}'`;

  for (const shellPath of candidates) {
    try {
      const { stdout } = await runner(shellPath, ["-lc", command], {
        env,
        timeoutMs,
      });
      const pathValue = extractMarkedPath(stdout);
      if (pathValue) {
        return { shellPath, pathValue };
      }
    } catch {
      // Ignore candidate failures and fall through to the next login shell.
    }
  }

  return { shellPath: null, pathValue: null };
}

export async function syncProcessPathFromLoginShell(options: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  runner?: ShellRunner;
} = {}): Promise<LoginShellEnvResult> {
  const env = options.env ?? process.env;
  const currentPath = env.PATH ?? env.Path ?? null;
  const { shellPath, pathValue } = await readLoginShellPath(options);
  const mergedPath = mergePathValues(currentPath, pathValue);
  const changed = Boolean(mergedPath && mergedPath !== currentPath);

  if (changed && mergedPath) {
    env.PATH = mergedPath;
  }

  return {
    changed,
    shellPath,
    loginPath: pathValue,
    mergedPath,
  };
}
