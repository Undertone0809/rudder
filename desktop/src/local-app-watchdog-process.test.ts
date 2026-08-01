import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { runBoundedChildProcess } from "./local-app-watchdog-process.mjs";

describe("Local App watchdog child commands", () => {
  it("fails closed and releases the watchdog when a cleanup child never exits", async () => {
    const startedAt = Date.now();
    await expect(runBoundedChildProcess(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
      timeoutMs: 30,
    })).rejects.toThrow(`timed out after 30ms`);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("does not hand cleanup back to the parent before the timed-out child exits", async () => {
    const child = new EventEmitter();
    const kill = vi.fn();
    Object.assign(child, { kill });
    const command = runBoundedChildProcess("taskkill.exe", [], {
      timeoutMs: 10,
      spawnProcess: () => child,
    });
    let settled = false;
    void command.then(
      () => { settled = true; },
      () => { settled = true; },
    );

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(kill).toHaveBeenCalledWith("SIGKILL");
    expect(settled).toBe(false);

    child.emit("exit", 1);
    await expect(command).rejects.toThrow("timed out after 10ms");
    expect(settled).toBe(true);
  });
});
