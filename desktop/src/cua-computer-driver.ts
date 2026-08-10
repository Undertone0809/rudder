import { randomUUID } from "node:crypto";
import { ComputerDriverError, type ComputerDriver, type ComputerDriverResult } from "./computer-driver.js";

type CuaDriverLike = {
  callTool(name: string, argumentsJson: string, options?: { signal: AbortSignal }): Promise<{
    text: string;
    structuredJson?: string;
    images: Array<{ mimeType: string; dataBase64: string }>;
    isError: boolean;
    errorCode?: string;
    action?: unknown;
  }>;
  metadata(options?: { signal: AbortSignal }): Promise<{ driverVersion: string }>;
  startSession(input: unknown, options?: { signal: AbortSignal }): Promise<unknown>;
  endSession(input: unknown): Promise<unknown>;
  shutdown(): Promise<void>;
  uniffiDestroy?: () => void;
};

function parseStructured(value: string | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function safeDriverError(code: string | undefined): ComputerDriverError {
  const safeCode = code && /^[a-z0-9_]+$/u.test(code) ? code : "driver_error";
  if (safeCode.includes("stale") || safeCode.includes("snapshot")) {
    return new ComputerDriverError("computer_stale_observation", "The Computer Use observation is stale. Observe the window again.");
  }
  if (safeCode.includes("permission") || safeCode.includes("accessibility") || safeCode.includes("screen_record")) {
    return new ComputerDriverError("computer_permission_required", "Computer Use requires Accessibility and Screen Recording access.");
  }
  if (safeCode.includes("not_found") || safeCode.includes("target_missing") || safeCode.includes("window_id")) {
    return new ComputerDriverError("computer_target_not_found", "The Computer Use target is no longer available.");
  }
  return new ComputerDriverError("computer_driver_error", "The Computer Use driver could not complete the action.");
}

export async function createCuaComputerDriver(): Promise<ComputerDriver> {
  const sdk = await import("@trycua/cua-driver");
  const native = sdk.CuaDriver.create(undefined) as CuaDriverLike;
  const metadata = await native.metadata();
  const generation = randomUUID();

  return {
    generation,
    version: metadata.driverVersion,
    async startSession(runId, signal) {
      await native.startSession(
        sdk.StartSessionInput.new({ session: runId, captureScope: sdk.CaptureScope.Window }),
        signal ? { signal } : undefined,
      );
    },
    async endSession(runId) {
      await native.endSession(sdk.EndSessionInput.new({ session: runId }));
    },
    async callTool(name, args, signal): Promise<ComputerDriverResult> {
      const result = await native.callTool(name, JSON.stringify(args), signal ? { signal } : undefined);
      if (result.isError) throw safeDriverError(result.errorCode);
      return {
        text: result.text,
        structured: parseStructured(result.structuredJson),
        images: result.images.map((image) => ({ mimeType: image.mimeType, base64: image.dataBase64 })),
        ...(result.action && typeof result.action === "object"
          ? { action: result.action as Record<string, unknown> }
          : {}),
      };
    },
    async shutdown() {
      await native.shutdown();
      native.uniffiDestroy?.();
    },
  };
}
