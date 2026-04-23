import { describe, expect, it } from "vitest";
import {
  extractMarkedPath,
  mergePathValues,
  readLoginShellPath,
  resolveLoginShellCandidates,
  syncProcessPathFromLoginShell,
} from "./login-shell-env.js";

describe("login shell PATH sync", () => {
  it("extracts the marked PATH payload even when shell startup prints noise", () => {
    const output = [
      "direnv: loading",
      "__RUDDER_LOGIN_SHELL_PATH_START__",
      "/Users/test/.nvm/versions/node/v22.17.0/bin:/usr/bin:/bin",
      "__RUDDER_LOGIN_SHELL_PATH_END__",
      "welcome",
    ].join("\n");

    expect(extractMarkedPath(output)).toBe("/Users/test/.nvm/versions/node/v22.17.0/bin:/usr/bin:/bin");
  });

  it("merges current PATH with login-shell PATH without duplicating entries", () => {
    expect(
      mergePathValues("/usr/bin:/bin", "/Users/test/.nvm/bin:/usr/bin:/bin"),
    ).toBe("/usr/bin:/bin:/Users/test/.nvm/bin");
  });

  it("prefers an absolute SHELL and falls back to common login shells", () => {
    expect(
      resolveLoginShellCandidates({ SHELL: "/opt/homebrew/bin/bash" }, "darwin"),
    ).toEqual([
      "/opt/homebrew/bin/bash",
      "/bin/zsh",
      "/bin/bash",
      "/bin/sh",
    ]);
  });

  it("reads PATH from the first login shell candidate that returns markers", async () => {
    const runnerCalls: string[] = [];
    const result = await readLoginShellPath({
      env: { SHELL: "/missing/zsh" },
      platform: "darwin",
      runner: async (shellPath) => {
        runnerCalls.push(shellPath);
        if (shellPath === "/missing/zsh") {
          throw new Error("missing");
        }
        return {
          stdout: [
            "noise",
            "__RUDDER_LOGIN_SHELL_PATH_START__",
            "/Users/test/.nvm/bin:/usr/bin:/bin",
            "__RUDDER_LOGIN_SHELL_PATH_END__",
          ].join("\n"),
          stderr: "",
        };
      },
    });

    expect(runnerCalls).toEqual(["/missing/zsh", "/bin/zsh"]);
    expect(result).toEqual({
      shellPath: "/bin/zsh",
      pathValue: "/Users/test/.nvm/bin:/usr/bin:/bin",
    });
  });

  it("updates process PATH with login-shell-managed Node bins", async () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin",
      SHELL: "/bin/zsh",
    };
    const result = await syncProcessPathFromLoginShell({
      env,
      platform: "darwin",
      runner: async () => ({
        stdout: [
          "__RUDDER_LOGIN_SHELL_PATH_START__",
          "/Users/test/.nvm/versions/node/v22.17.0/bin:/usr/bin:/bin",
          "__RUDDER_LOGIN_SHELL_PATH_END__",
        ].join("\n"),
        stderr: "",
      }),
    });

    expect(result.changed).toBe(true);
    expect(result.shellPath).toBe("/bin/zsh");
    expect(env.PATH).toBe("/usr/bin:/bin:/Users/test/.nvm/versions/node/v22.17.0/bin");
  });
});
