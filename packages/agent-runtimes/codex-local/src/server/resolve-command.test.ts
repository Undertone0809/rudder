import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCodexCommand } from "./resolve-command.js";

const itWindows = process.platform === "win32" ? it : it.skip;
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "rudder-codex-command-"));
  tempRoots.push(root);
  return root;
}

describe("resolveCodexCommand", () => {
  itWindows("keeps a working Windows command wrapper", async () => {
    const root = await createTempRoot();
    const bin = path.join(root, "path-bin");
    const target = path.join(root, "working", "codex.exe");
    const wrapper = path.join(bin, "codex.cmd");
    await mkdir(path.dirname(target), { recursive: true });
    await mkdir(bin, { recursive: true });
    await writeFile(target, "", "utf8");
    await writeFile(wrapper, `@echo off\r\n"${target}" %*\r\n`, "utf8");

    const result = await resolveCodexCommand("codex", root, {
      PATH: bin,
      PATHEXT: ".CMD;.EXE",
      LOCALAPPDATA: path.join(root, "local"),
    });

    expect(result).toBe("codex");
  });

  itWindows("recovers a stale wrapper with the newest Codex Desktop executable", async () => {
    const root = await createTempRoot();
    const bin = path.join(root, "path-bin");
    const localAppData = path.join(root, "local");
    const older = path.join(localAppData, "OpenAI", "Codex", "bin", "older", "codex.exe");
    const current = path.join(localAppData, "OpenAI", "Codex", "bin", "current", "codex.exe");
    const wrapper = path.join(bin, "codex.cmd");
    await mkdir(bin, { recursive: true });
    await mkdir(path.dirname(older), { recursive: true });
    await mkdir(path.dirname(current), { recursive: true });
    await writeFile(older, "", "utf8");
    await writeFile(current, "", "utf8");
    await utimes(older, new Date(1_000), new Date(1_000));
    await utimes(current, new Date(2_000), new Date(2_000));
    await writeFile(
      wrapper,
      '@echo off\r\n"C:\\Users\\example\\AppData\\Local\\OpenAI\\Codex\\bin\\removed\\codex.exe" %*\r\n',
      "utf8",
    );

    const result = await resolveCodexCommand("codex", root, {
      PATH: bin,
      PATHEXT: ".CMD;.EXE",
      LOCALAPPDATA: localAppData,
    });

    expect(result).toBe(current);
  });

  itWindows("recovers when Codex Desktop is installed but absent from PATH", async () => {
    const root = await createTempRoot();
    const localAppData = path.join(root, "local");
    const current = path.join(localAppData, "OpenAI", "Codex", "bin", "current", "codex.exe");
    await mkdir(path.dirname(current), { recursive: true });
    await writeFile(current, "", "utf8");

    const result = await resolveCodexCommand("codex", root, {
      PATH: path.join(root, "empty"),
      PATHEXT: ".CMD;.EXE",
      LOCALAPPDATA: localAppData,
    });

    expect(result).toBe(current);
  });
});
