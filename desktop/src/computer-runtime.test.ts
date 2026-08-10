import { describe, expect, it, vi } from "vitest";
import type { ComputerUseBrokerCommand } from "@rudderhq/shared";
import type { ComputerDriver } from "./computer-driver.js";
import { createComputerRuntime } from "./computer-runtime.js";

const identity = { orgId: "org-1", agentId: "agent-1", runId: "run-1" };
const command = (action: ComputerUseBrokerCommand["action"], args: Record<string, unknown> = {}, runId = "run-1") => ({
  identity: { ...identity, runId },
  action,
  args,
});

function createDriver(): ComputerDriver {
  return {
    generation: "driver-generation-1",
    version: "0.19.2",
    startSession: vi.fn(async () => undefined),
    endSession: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
    callTool: vi.fn(async (name) => {
      if (name === "list_apps") return { text: "apps", structured: { apps: [{ name: "TextEdit", pid: 42, running: true }] }, images: [] };
      if (name === "list_windows") return { text: "windows", structured: { windows: [{ window_id: 7, z_index: 2 }] }, images: [] };
      if (name === "get_window_state") return {
        text: "state",
        structured: { snapshot_id: "snapshot-1", elements: [{ index: 3, role: "button" }] },
        images: [{ mimeType: "image/png", base64: "image-data" }],
      };
      return { text: "action", structured: { effect: "confirmed" }, images: [] };
    }),
  };
}

describe("Computer runtime", () => {
  it("enforces observe-action-observe and binds observations to one Run", async () => {
    const driver = createDriver();
    const runtime = createComputerRuntime({ createDriver: async () => driver });
    const observed = await runtime.execute(command("get_app_state", { app: "TextEdit" })) as { observationId: string };

    await expect(runtime.execute(command("click", {
      observationId: observed.observationId,
      elementIndex: 3,
    }))).resolves.toMatchObject({ effect: "confirmed", pid: 42, windowId: 7 });
    expect(driver.callTool).toHaveBeenLastCalledWith("click", expect.objectContaining({
      session: "run-1",
      pid: 42,
      window_id: 7,
      snapshot_id: "snapshot-1",
      element_index: 3,
    }), undefined);

    await expect(runtime.execute(command("click", {
      observationId: observed.observationId,
      elementIndex: 3,
    }))).rejects.toMatchObject({ code: "computer_stale_observation" });

    await expect(runtime.execute(command("click", {
      observationId: observed.observationId,
      elementIndex: 3,
    }, "run-2"))).rejects.toMatchObject({ code: "computer_stale_observation" });
  });

  it("resolves list_windows from an exact app name", async () => {
    const driver = createDriver();
    const runtime = createComputerRuntime({ createDriver: async () => driver });

    await expect(runtime.execute(command("list_windows", { app: "TextEdit" })))
      .resolves.toMatchObject({ windows: [{ window_id: 7 }] });
    expect(driver.callTool).toHaveBeenLastCalledWith("list_windows", {
      pid: 42,
    }, undefined);
  });

  it("rejects expired observations and Stop invalidates the Run session", async () => {
    let now = 1_000;
    const driver = createDriver();
    const runtime = createComputerRuntime({ createDriver: async () => driver, now: () => now });
    const first = await runtime.execute(command("get_app_state", { pid: 42, windowId: 7 })) as { observationId: string };
    now += 120_001;
    await expect(runtime.execute(command("click", { observationId: first.observationId, x: 1, y: 2 })))
      .rejects.toMatchObject({ code: "computer_stale_observation" });

    const second = await runtime.execute(command("get_app_state", { pid: 42, windowId: 7 })) as { observationId: string };
    await expect(runtime.execute(command("stop"))).resolves.toEqual({ stopped: true });
    expect(driver.endSession).toHaveBeenCalledWith("run-1");
    await expect(runtime.execute(command("click", { observationId: second.observationId, x: 1, y: 2 })))
      .rejects.toMatchObject({ code: "computer_stale_observation" });
  });

  it("reaps Driver sessions when their owning Run is no longer active", async () => {
    const driver = createDriver();
    const runtime = createComputerRuntime({ createDriver: async () => driver });
    await runtime.execute(command("list_apps"));

    await runtime.reapInactiveRuns(async (runIdentity) => runIdentity.runId !== "run-1");

    expect(driver.endSession).toHaveBeenCalledWith("run-1");
  });
});
