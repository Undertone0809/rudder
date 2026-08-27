import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyDevDesktopExit,
  classifyDevServerExit,
  stopManagedDevShellChildren,
} from "./dev-shell-lifecycle.mjs";

describe("dev shell lifecycle", () => {
  it("keeps migration application inside the recovery-aware server startup", () => {
    const runnerSource = readFileSync(path.join(process.cwd(), "scripts", "dev-runner.mjs"), "utf8");

    expect(runnerSource).not.toContain('pnpmBin, ["db:migrate"]');
    expect(runnerSource).toContain("the server will apply them with a recovery point");
  });

  it("accepts a server exit only after Desktop ownership is verified", () => {
    expect(classifyDevServerExit({ runtimeOwnerKind: "desktop", shuttingDown: false }))
      .toBe("desktop-managed");
  });

  it("treats a server exit without verified Desktop ownership as fatal", () => {
    expect(classifyDevServerExit({ runtimeOwnerKind: null, shuttingDown: false }))
      .toBe("fatal");
    expect(classifyDevServerExit({ runtimeOwnerKind: "dev_runner", shuttingDown: false }))
      .toBe("fatal");
  });

  it("ignores child exits during orchestrated shutdown", () => {
    expect(classifyDevServerExit({ runtimeOwnerKind: null, shuttingDown: true }))
      .toBe("ignore");
  });

  it("exits the parent when the Desktop-owned runtime closes", () => {
    expect(classifyDevDesktopExit({ desktopOwnsRuntime: true, shuttingDown: false }))
      .toBe("exit-parent");
  });

  it("keeps the dev runtime alive when an attached Desktop closes", () => {
    expect(classifyDevDesktopExit({ desktopOwnsRuntime: false, shuttingDown: false }))
      .toBe("runtime-still-running");
  });

  it("runs local Vite outside the API process and points Desktop at it", () => {
    const shellSource = readFileSync(path.join(process.cwd(), "scripts", "dev-shell.mjs"), "utf8");

    expect(shellSource).toContain('env.RUDDER_UI_DEV_MIDDLEWARE = "false"');
    expect(shellSource).toContain('RUDDER_DESKTOP_LOAD_URL: uiOrigin');
    expect(shellSource).toContain("resolveStandaloneDevUiCommandArgs()");
    expect(shellSource).toContain("const runtimeApiOrigin = await waitForDevRuntimeReady(env)");
    expect(shellSource).toContain("RUDDER_UI_PROXY_TARGET: runtimeApiOrigin");

    const viteSource = readFileSync(path.join(process.cwd(), "ui", "vite.config.ts"), "utf8");
    expect(viteSource).toContain("strictPort: true");
  });

  it("stops a live Vite child during fatal orchestrator shutdown", async () => {
    const uiChild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
      stdio: "ignore",
    });
    await new Promise((resolve, reject) => {
      uiChild.once("spawn", resolve);
      uiChild.once("error", reject);
    });

    await stopManagedDevShellChildren([uiChild], 2_000);

    expect(uiChild.killed).toBe(true);
    expect(uiChild.exitCode !== null || uiChild.signalCode !== null).toBe(true);
  });
});
