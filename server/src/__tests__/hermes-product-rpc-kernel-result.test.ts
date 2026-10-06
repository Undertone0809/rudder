import { executeHermesProductRpcChat, type HermesProductRpcProfile } from "@rudderhq/agent-runtime-hermes-gateway/server";
import { hasConfirmedNativeWriterQuiescence } from "@rudderhq/agent-runtime-utils";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { nativeExecutionSpanCompleteness, selectorForRuntime } from "../services/runtime-kernel/native-session.js";
import {
  HERMES_PRODUCT_RPC_SPAN_BASELINE_PATH_ENV,
  HERMES_PRODUCT_RPC_SPAN_CONFIG_PATH_ENV,
  HERMES_PRODUCT_RPC_SPAN_NONCE_ENV,
  HERMES_PRODUCT_RPC_SPAN_ROWS_PATH_ENV,
} from "../../../packages/agent-runtimes/hermes-gateway/src/server/product-rpc-mcp-bootstrap.js";

async function writeSpanCaptureReceipt(
  runtimeEnv: Record<string, string> | undefined,
  sessionId: string,
  tailRowId: number,
  rowIds: number[],
  pid: number,
): Promise<void> {
  const configPath = runtimeEnv?.[HERMES_PRODUCT_RPC_SPAN_CONFIG_PATH_ENV];
  const baselinePath = runtimeEnv?.[HERMES_PRODUCT_RPC_SPAN_BASELINE_PATH_ENV];
  const rowsPath = runtimeEnv?.[HERMES_PRODUCT_RPC_SPAN_ROWS_PATH_ENV];
  const nonce = runtimeEnv?.[HERMES_PRODUCT_RPC_SPAN_NONCE_ENV];
  if (!configPath || !baselinePath || !rowsPath || !nonce) throw new Error("Hermes span-capture environment is missing.");
  const config = JSON.parse(await readFile(configPath, "utf8")) as { version?: number; nonce?: string; sessionId?: string };
  if (config.version !== 1 || config.nonce !== nonce || config.sessionId !== sessionId) {
    throw new Error("Hermes span-capture config did not bind this session.");
  }
  await writeFile(baselinePath, `${JSON.stringify({
    version: 1, kind: "baseline", nonce, sessionId, pid, processRole: "gateway",
    status: "ready", tailRowId, sessionExists: true,
  })}\n`, { mode: 0o600, flag: "wx" });
  await writeFile(rowsPath, `${JSON.stringify({
    version: 1, kind: "rows", nonce, sessionId, pid, processRole: "gateway", rowIds,
  })}\n`, { mode: 0o600, flag: "wx" });
}

// Adapter-to-kernel regression only. No provider, installed Hermes, or public
// acceptance claim: the gateway and history fence are explicit test doubles.
it("returns sealable exact first/resume Hermes results to the common native kernel", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hermes-kernel-result-"));
  try {
    await mkdir(path.join(root, "tui_gateway"));
    await writeFile(path.join(root, "tui_gateway", "entry.py"), "# test fixture\n");
    const profile: HermesProductRpcProfile = {
      binding: { hostId: "local", profileId: "test" },
      command: process.execPath, args: [], cwd: root,
      hermesPythonCommand: process.execPath, hermesSourcePath: root,
      hermesHome: root, providerVersion: "0.21.0",
    };
    const nativeSessionId = "hermes-kernel-session";
    let sessionParams: Record<string, unknown> | null = null;
    for (const [start, end] of [[40, 44], [44, 48]]) {
      const methods: string[] = [];
      let held = true;
      let tailReads = 0;
      const result = await executeHermesProductRpcChat({
        profile,
        sessionId: sessionParams ? nativeSessionId : null,
        sessionParams, prompt: "test input", timeoutMs: 1_000,
        onLog: async () => {},
        readHistoryTail: async () => ({
          availability: "available", tailRowId: tailReads++ === 0 ? start : end,
          relation: "none", successorSessionId: null,
        }),
        readHistoryRangeRowIds: async ({ sessionId: selectedSessionId, startExclusive, endInclusive }) => {
          expect(selectedSessionId).toBe(nativeSessionId);
          return [startExclusive! + 1, endInclusive!];
        },
        acquireHistoryFence: async () => ({
          tailRowId: start, sessionExists: true, isHeld: () => held,
          release: async () => { held = false; },
        }),
        waitForSessionLease: async () => true,
        createClient: async ({ onNotification, onSpawn, profile: rpcProfile }) => {
          const emit = (type: string, payload: Record<string, unknown> = {}) =>
            onNotification("event", { type, session_id: "live-session", payload });
          await onSpawn?.({ pid: process.pid, startedAt: new Date().toISOString() });
          queueMicrotask(() => onNotification("event", { type: "gateway.ready", payload: {} }));
          return {
            close: async () => {},
            request: async (method) => {
              methods.push(method);
              if (method === "ping") return { pong: true };
              if (method === "gateway.capabilities") return { per_session_exclusive_submit: true };
              if (method === "session.create") return { session_id: "live-session", stored_session_id: nativeSessionId };
              if (method === "session.resume") return { session_id: "live-session", session_key: nativeSessionId, running: false, auto_continue: false };
              if (method === "prompt.submit") {
                // The Product Gateway acknowledges acceptance before streaming
                // terminal events. Delaying this response until the history
                // fence is released deadlocks the run: release follows settle.
                await writeSpanCaptureReceipt(rpcProfile.env, nativeSessionId, start, [start + 1, end], process.pid);
                emit("message.start");
                emit("message.complete", { status: "complete", text: "done" });
                emit("session.info", { running: false });
                return { status: "streaming" };
              }
              return {};
            },
          };
        },
      });
      expect(result.exitCode).toBe(0);
      expect(hasConfirmedNativeWriterQuiescence(result)).toBe(true);
      expect(result.sessionId).toBe(nativeSessionId);
      expect(methods).toContain(sessionParams ? "session.resume" : "session.create");
      const selector = selectorForRuntime({
        runtimeType: "hermes_gateway", sessionId: nativeSessionId,
        executionRef: null, inputCorrelationRef: `input-${end}`, runId: `run-${end}`, result,
      });
      expect(selector).toMatchObject({
        kind: "hermes_execution", sessionRef: nativeSessionId,
        providerExecutionRef: `hermes:db:${nativeSessionId}:${end}`,
        sourceRangeRef: JSON.stringify({
          version: 1, status: "exact", sessionId: nativeSessionId,
          startExclusive: start, endInclusive: end, captureVersion: 1, capturedRowCount: 2,
        }),
      });
      expect(nativeExecutionSpanCompleteness({
        runtimeType: "hermes_gateway", sessionId: result.sessionId!,
        executionRef: result.resultJson?.executionRef as string, selector, result,
      })).toBe("complete");
      sessionParams = result.sessionParams ?? null;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
