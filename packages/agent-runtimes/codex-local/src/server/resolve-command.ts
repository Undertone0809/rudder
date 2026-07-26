import { resolveCommandPath } from "@rudderhq/agent-runtime-utils/server-utils";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const CODEX_DESKTOP_EXE_RELATIVE_DIR = path.join("OpenAI", "Codex", "bin");
const STATIC_WINDOWS_EXE_RE = /"([^"\r\n]*\\codex\.exe)"/i;

async function pathIsFile(candidate: string): Promise<boolean> {
  return stat(candidate).then((value) => value.isFile()).catch(() => false);
}

async function wrapperTargetsMissingCodexExe(wrapperPath: string): Promise<boolean> {
  const contents = await readFile(wrapperPath, "utf8").catch(() => "");
  const target = contents.match(STATIC_WINDOWS_EXE_RE)?.[1];
  return Boolean(target) && !(await pathIsFile(target!));
}

async function findCurrentCodexDesktopExe(env: NodeJS.ProcessEnv): Promise<string | null> {
  const localAppData = env.LOCALAPPDATA ?? process.env.LOCALAPPDATA;
  if (!localAppData) return null;

  const binRoot = path.join(localAppData, CODEX_DESKTOP_EXE_RELATIVE_DIR);
  const entries = await readdir(binRoot, { withFileTypes: true }).catch(() => []);
  const candidates = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const executable = path.join(binRoot, entry.name, "codex.exe");
        const metadata = await stat(executable).catch(() => null);
        return metadata?.isFile() ? { executable, modifiedAt: metadata.mtimeMs } : null;
      }),
  );

  return candidates
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
    .sort((left, right) => right.modifiedAt - left.modifiedAt)[0]?.executable ?? null;
}

export async function resolveCodexCommand(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  if (process.platform !== "win32" || command.trim().toLowerCase() !== "codex") return command;

  const resolved = await resolveCommandPath(command, cwd, env);
  if (resolved && !/\.(cmd|bat)$/i.test(resolved)) return resolved;
  if (resolved && !(await wrapperTargetsMissingCodexExe(resolved))) return command;

  return await findCurrentCodexDesktopExe(env) ?? command;
}
