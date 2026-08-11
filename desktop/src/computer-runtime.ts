import {
  COMPUTER_USE_ACTIONS,
  computerUseActionSchemas,
  type ComputerUseBrokerCommand,
  type ComputerUseRuntimeIdentity
} from "@rudderhq/shared/computer-use";
import { randomUUID } from "node:crypto";
import { ComputerDriverError, type ComputerDriver, type ComputerDriverResult } from "./computer-driver.js";

const OBSERVATION_TTL_MS = 2 * 60_000;

type Observation = {
  id: string;
  runId: string;
  generation: string;
  pid: number;
  windowId: number;
  snapshotId: string | null;
  expiresAt: number;
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function safeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function serializeResult(result: ComputerDriverResult, extra: Record<string, unknown> = {}) {
  return {
    ...result.structured,
    ...extra,
    text: result.text,
    images: result.images,
    ...(result.action ? { action: result.action } : {}),
  };
}

export function createComputerRuntime(options: {
  createDriver(): Promise<ComputerDriver>;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  let driver: ComputerDriver | null = null;
  let driverPromise: Promise<ComputerDriver> | null = null;
  const sessions = new Map<string, ComputerUseRuntimeIdentity>();
  const observations = new Map<string, Observation>();

  const getDriver = async () => {
    if (driver) return driver;
    if (!driverPromise) {
      driverPromise = options.createDriver().then((created) => {
        driver = created;
        return created;
      }).finally(() => {
        driverPromise = null;
      });
    }
    return driverPromise;
  };

  const ensureSession = async (identity: ComputerUseRuntimeIdentity, signal?: AbortSignal) => {
    const activeDriver = await getDriver();
    if (!sessions.has(identity.runId)) {
      await activeDriver.startSession(identity.runId, signal);
      sessions.set(identity.runId, identity);
    }
    return activeDriver;
  };

  const invalidateRun = (runId: string) => {
    for (const [id, observation] of observations) {
      if (observation.runId === runId) observations.delete(id);
    }
  };

  const observationFor = (runId: string, observationId: unknown): Observation => {
    if (typeof observationId !== "string") {
      throw new ComputerDriverError("computer_invalid_argument", "Computer Use action requires an observation.");
    }
    const observation = observations.get(observationId);
    if (!observation || observation.runId !== runId || observation.expiresAt <= now()
      || !driver || observation.generation !== driver.generation) {
      observations.delete(observationId);
      throw new ComputerDriverError("computer_stale_observation", "The Computer Use observation is stale. Observe the window again.");
    }
    return observation;
  };

  const resolveTarget = async (
    activeDriver: ComputerDriver,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ pid: number; windowId: number }> => {
    let pid = safeInteger(args.pid);
    if (!pid && typeof args.app === "string") {
      const apps = await activeDriver.callTool("list_apps", {}, signal);
      const appName = args.app.trim().toLowerCase();
      const candidates = Array.isArray(apps.structured.apps) ? apps.structured.apps.map(record) : [];
      const match = candidates.find((app) => {
        const name = typeof app.name === "string" ? app.name.toLowerCase() : "";
        const bundleId = typeof app.bundle_id === "string" ? app.bundle_id.toLowerCase() : "";
        return app.running === true && (name === appName || bundleId === appName);
      });
      pid = safeInteger(match?.pid);
    }
    if (!pid) throw new ComputerDriverError("computer_target_not_found", "The requested application is not running.");
    let windowId = safeInteger(args.windowId);
    if (!windowId) {
      const windows = await activeDriver.callTool("list_windows", { pid, on_screen_only: true }, signal);
      const candidates = Array.isArray(windows.structured.windows)
        ? windows.structured.windows.map(record).filter((item) => safeInteger(item.window_id))
        : [];
      candidates.sort((left, right) => {
        const leftZ = typeof left.z_index === "number" ? left.z_index : Number.NEGATIVE_INFINITY;
        const rightZ = typeof right.z_index === "number" ? right.z_index : Number.NEGATIVE_INFINITY;
        return rightZ - leftZ;
      });
      windowId = safeInteger(candidates[0]?.window_id);
    }
    if (!windowId) throw new ComputerDriverError("computer_target_not_found", "The requested application window is not available.");
    return { pid, windowId };
  };

  const resolvePid = async (
    activeDriver: ComputerDriver,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<number | null> => {
    const explicitPid = safeInteger(args.pid);
    if (explicitPid) return explicitPid;
    if (typeof args.app !== "string") return null;
    const apps = await activeDriver.callTool("list_apps", {}, signal);
    const appName = args.app.trim().toLowerCase();
    const candidates = Array.isArray(apps.structured.apps) ? apps.structured.apps.map(record) : [];
    const match = candidates.find((app) => {
      const name = typeof app.name === "string" ? app.name.toLowerCase() : "";
      const bundleId = typeof app.bundle_id === "string" ? app.bundle_id.toLowerCase() : "";
      return app.running === true && (name === appName || bundleId === appName);
    });
    return safeInteger(match?.pid);
  };

  const execute = async (command: ComputerUseBrokerCommand): Promise<unknown> => {
    if (!COMPUTER_USE_ACTIONS.includes(command.action)) {
      throw new ComputerDriverError("computer_invalid_argument", "Unknown Computer Use action.");
    }
    const parsed = computerUseActionSchemas[command.action].safeParse(command.args ?? {});
    if (!parsed.success) throw new ComputerDriverError("computer_invalid_argument", "Computer Use arguments are invalid.");
    const args = parsed.data as Record<string, unknown>;
    const runId = command.identity.runId;

    if (command.action === "stop") {
      invalidateRun(runId);
      if (driver && sessions.delete(runId)) await driver.endSession(runId);
      return { stopped: true };
    }

    const activeDriver = await ensureSession(command.identity, command.signal);
    if (command.action === "list_apps") {
      return serializeResult(await activeDriver.callTool("list_apps", {}, command.signal));
    }
    if (command.action === "launch_app") {
      const result = await activeDriver.callTool("launch_app", {
        ...(typeof args.name === "string" ? { name: args.name } : {}),
        ...(typeof args.bundleId === "string" ? { bundle_id: args.bundleId } : {}),
        ...(args.newInstance === true ? { creates_new_application_instance: true } : {}),
      }, command.signal);
      return serializeResult(result);
    }
    if (command.action === "list_windows") {
      const pid = await resolvePid(activeDriver, args, command.signal);
      if (typeof args.app === "string" && !pid) {
        throw new ComputerDriverError("computer_target_not_found", "The requested application is not running.");
      }
      const result = await activeDriver.callTool("list_windows", {
        ...(pid ? { pid } : {}),
        ...(args.onScreenOnly !== undefined ? { on_screen_only: args.onScreenOnly } : {}),
      }, command.signal);
      return serializeResult(result);
    }
    if (command.action === "get_app_state") {
      const target = await resolveTarget(activeDriver, args, command.signal);
      for (const [id, observation] of observations) {
        if (observation.runId === runId && observation.pid === target.pid && observation.windowId === target.windowId) {
          observations.delete(id);
        }
      }
      const result = await activeDriver.callTool("get_window_state", {
        session: runId,
        pid: target.pid,
        window_id: target.windowId,
        ...(args.includeScreenshot !== undefined ? { include_screenshot: args.includeScreenshot } : {}),
        ...(typeof args.query === "string" ? { query: args.query } : {}),
        ...(typeof args.maxElements === "number" ? { max_elements: args.maxElements } : {}),
        ...(typeof args.maxDepth === "number" ? { max_depth: args.maxDepth } : {}),
      }, command.signal);
      const snapshotId = typeof result.structured.snapshot_id === "string" ? result.structured.snapshot_id : null;
      const observationId = randomUUID();
      observations.set(observationId, {
        id: observationId,
        runId,
        generation: activeDriver.generation,
        pid: target.pid,
        windowId: target.windowId,
        snapshotId,
        expiresAt: now() + OBSERVATION_TTL_MS,
      });
      return serializeResult(result, {
        observationId,
        pid: target.pid,
        windowId: target.windowId,
        expiresAt: new Date(now() + OBSERVATION_TTL_MS).toISOString(),
      });
    }

    const observation = observationFor(runId, args.observationId);
    // Every action consumes its observation. Even a failed driver call may have
    // partially changed the target, so the next action must observe again.
    observations.delete(observation.id);
    const common = {
      session: runId,
      pid: observation.pid,
      window_id: observation.windowId,
      ...(observation.snapshotId ? { snapshot_id: observation.snapshotId } : {}),
      ...(typeof args.elementIndex === "number" ? { element_index: args.elementIndex } : {}),
      ...(typeof args.elementToken === "string" ? { element_token: args.elementToken } : {}),
      ...(typeof args.x === "number" ? { x: args.x } : {}),
      ...(typeof args.y === "number" ? { y: args.y } : {}),
      ...(typeof args.deliveryMode === "string" ? { delivery_mode: args.deliveryMode } : {}),
    };
    let toolName: string = command.action;
    let toolArgs: Record<string, unknown> = common;
    if (command.action === "click") {
      toolArgs = { ...common, ...(args.button ? { button: args.button } : {}), ...(args.count ? { count: args.count } : {}) };
    } else if (command.action === "drag" || command.action === "select_text") {
      toolName = "drag";
      toolArgs = {
        session: runId,
        pid: observation.pid,
        window_id: observation.windowId,
        from_x: args.fromX,
        from_y: args.fromY,
        to_x: args.toX,
        to_y: args.toY,
        ...(typeof args.durationMs === "number" ? { duration_ms: args.durationMs } : {}),
        ...(typeof args.steps === "number" ? { steps: args.steps } : {}),
        ...(typeof args.deliveryMode === "string" ? { delivery_mode: args.deliveryMode } : {}),
      };
    } else if (command.action === "type_text") {
      toolArgs = { ...common, text: args.text, ...(typeof args.delayMs === "number" ? { delay_ms: args.delayMs } : {}) };
    } else if (command.action === "press_key") {
      if (Array.isArray(args.modifiers) && args.modifiers.length > 0) {
        toolName = "hotkey";
        const { snapshot_id: _snapshotId, element_index: _elementIndex, element_token: _elementToken, ...hotkeyTarget } = common;
        toolArgs = { ...hotkeyTarget, keys: [...args.modifiers, args.key] };
      } else {
        toolArgs = { ...common, key: args.key };
      }
    } else if (command.action === "scroll") {
      toolArgs = {
        ...common,
        direction: args.direction,
        ...(typeof args.amount === "number" ? { amount: args.amount } : {}),
        ...(typeof args.by === "string" ? { by: args.by } : {}),
      };
    } else if (command.action === "set_value") {
      toolArgs = { ...common, value: args.value };
    } else if (command.action === "perform_secondary_action") {
      toolName = "click";
      toolArgs = { ...common, action: args.action };
    }
    const result = await activeDriver.callTool(toolName, toolArgs, command.signal);
    return serializeResult(result, {
      observationId: observation.id,
      pid: observation.pid,
      windowId: observation.windowId,
    });
  };

  const endRun = async (runId: string) => {
    invalidateRun(runId);
    if (driver && sessions.delete(runId)) await driver.endSession(runId);
  };

  const reapInactiveRuns = async (
    isRunActive: (identity: ComputerUseRuntimeIdentity) => Promise<boolean>,
  ) => {
    for (const identity of [...sessions.values()]) {
      if (!await isRunActive(identity)) await endRun(identity.runId);
    }
  };

  const shutdown = async () => {
    const current = driver;
    driver = null;
    for (const runId of sessions.keys()) await current?.endSession(runId).catch(() => undefined);
    sessions.clear();
    observations.clear();
    await current?.shutdown();
  };

  return { execute, endRun, reapInactiveRuns, shutdown };
}

export type ComputerRuntime = ReturnType<typeof createComputerRuntime>;
