import type {
  AgentRuntimeApprovalDecision,
  AgentRuntimeApprovalRequest,
  AgentRuntimeControlAttemptLease,
  AgentRuntimeControlHandle,
} from "@rudderhq/agent-runtime-utils";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildHermesProductRpcSessionParams,
  executeHermesProductRpcChat,
  HERMES_PRODUCT_RPC_TRANSPORT,
  type HermesProductRpcProfile,
} from "./product-rpc.js";

type GatewayEvent = (type: string, payload?: Record<string, unknown>, sessionId?: string | null) => void;
type GatewayHandler = (
  method: string,
  params: Record<string, unknown>,
  emit: GatewayEvent,
) => unknown | Promise<unknown>;

async function makeProfile(): Promise<{ profile: HermesProductRpcProfile; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-hermes-product-rpc-"));
  const source = path.join(root, "source");
  await fs.mkdir(path.join(source, "tui_gateway"), { recursive: true });
  await fs.writeFile(path.join(source, "tui_gateway", "entry.py"), "# test fixture\n");
  return {
    profile: {
      binding: { hostId: "host-hermes-test", profileId: "profile-hermes-test" },
      command: process.execPath,
      args: [],
      cwd: root,
      hermesPythonCommand: process.execPath,
      hermesSourcePath: source,
      hermesHome: path.join(root, "home"),
      providerVersion: "0.21.0",
    },
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

function mockGateway(handler: GatewayHandler = () => undefined) {
  let notify: ((method: string, params: Record<string, unknown>) => void) | null = null;
  let activeSessionId = "hermes-product-runtime-1";
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const timeline: string[] = [];
  const emit: GatewayEvent = (type, payload = {}, sessionId = activeSessionId) => {
    notify?.("event", {
      type,
      ...(sessionId ? { session_id: sessionId } : {}),
      payload,
    });
  };
  const client = {
    async request(method: string, params: Record<string, unknown>) {
      calls.push({ method, params });
      timeline.push(method);
      const handled = await handler(method, params, emit);
      if (handled !== undefined) return handled;
      if (method === "ping") return { pong: true };
      if (method === "gateway.capabilities") return { per_session_exclusive_submit: true };
      if (method === "session.create") return { session_id: activeSessionId, stored_session_id: "hermes-product-session" };
      if (method === "session.resume") {
        activeSessionId = "hermes-product-runtime-resumed";
        return { session_id: activeSessionId, session_key: params.session_id, auto_continue: false, running: false, status: "idle" };
      }
      if (method === "session.info") return { info: { running: false, model: "hermes-test-model" } };
      if (method === "session.redirect") return { status: "redirected" };
      if (method === "session.interrupt") return { status: "interrupted" };
      return { status: "ok" };
    },
    async close() {
      timeline.push("close");
    },
  };
  const createClient = async ({
    onNotification,
  }: {
    onNotification: (method: string, params: Record<string, unknown>) => void;
  }) => {
    notify = onNotification;
    queueMicrotask(() => emit("gateway.ready", {}, null));
    return client as never;
  };
  return { calls, timeline, client, createClient };
}

function emitTurnComplete(emit: GatewayEvent, status = "complete") {
  emit("message.complete", {
    text: "Hermes product response",
    status,
    model: "hermes-test-model",
    usage: { inputTokens: 8, outputTokens: 3 },
  });
  emit("session.info", { running: false, model: "hermes-test-model" });
}

function runInput(
  profile: HermesProductRpcProfile,
  createClient: ReturnType<typeof mockGateway>["createClient"],
  readHistoryTail?: NonNullable<Parameters<typeof executeHermesProductRpcChat>[0]["readHistoryTail"]>,
) {
  const tails = [40, 44];
  return {
    profile,
    sessionId: null,
    sessionParams: null,
    prompt: "Use the native Hermes session.",
    timeoutMs: 2_000,
    onLog: async () => undefined,
    createClient,
    readHistoryTail: readHistoryTail ?? (async () => ({
      availability: "available",
      tailRowId: tails.shift() ?? 44,
      relation: "none",
      successorSessionId: null,
    })),
  };
}

describe("Hermes Product Gateway RPC", () => {
  it("submits through a native session and round-trips the correlated approval choice", async () => {
    const fixture = await makeProfile();
    try {
      let approvalRequest: AgentRuntimeApprovalRequest | null = null;
      const gateway = mockGateway((method, _params, emit) => {
        if (method === "prompt.submit") {
          emit("message.start");
          emit("approval.request", {
            request_id: "approval-provider-17",
            description: "Run the requested command?",
            command: "npm test",
            choices: ["once", "session", "always", "deny"],
          });
          return { status: "streaming" };
        }
        if (method === "approval.respond") {
          emitTurnComplete(emit);
          return { status: "ok" };
        }
        return undefined;
      });

      const result = await executeHermesProductRpcChat({
        ...runInput(fixture.profile, gateway.createClient),
        requestApproval: async (request) => {
          approvalRequest = request;
          return { id: "rudder-approval-17", status: "pending" };
        },
        waitForApproval: async (id) => ({
          id,
          status: "approved",
          inputResponse: { answers: [{ questionId: "hermes_product_approval", optionIds: ["hermes_choice_1"] }] },
        } satisfies AgentRuntimeApprovalDecision),
      });

      expect(result).toMatchObject({
        exitCode: 0,
        provider: "hermes",
        sessionId: "hermes-product-session",
        sessionParams: { transport: HERMES_PRODUCT_RPC_TRANSPORT },
        usage: { inputTokens: 8, outputTokens: 3 },
        summary: "Hermes product response",
        resultJson: { backend: "native_product_rpc", nativeSession: true },
      });
      expect(gateway.calls.map(({ method }) => method)).toEqual(expect.arrayContaining([
        "gateway.capabilities",
        "session.create",
        "prompt.submit",
        "approval.respond",
      ]));
      expect(gateway.calls.find(({ method }) => method === "approval.respond")?.params).toMatchObject({
        session_id: "hermes-product-runtime-1",
        request_id: "approval-provider-17",
        choice: "once",
      });
      expect(approvalRequest).toMatchObject({
        type: "agent_runtime",
        payload: { protocol: "native_product_rpc", requestId: "approval-provider-17" },
        inputRequest: { questions: [{ id: "hermes_product_approval" }] },
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("records an exact Product Gateway row interval that excludes pre-existing session history", async () => {
    const fixture = await makeProfile();
    try {
      const tails = [40, 44];
      const reads: string[] = [];
      const readHistoryTail: NonNullable<Parameters<typeof executeHermesProductRpcChat>[0]["readHistoryTail"]> = async (_profile, sessionId) => {
        reads.push(sessionId);
        return {
          availability: "available",
          tailRowId: tails.shift() ?? null,
          relation: "none",
          successorSessionId: null,
        };
      };
      const gateway = mockGateway((method, _params, emit) => {
        if (method === "prompt.submit") {
          emit("message.start");
          emitTurnComplete(emit);
          return { status: "streaming" };
        }
        return undefined;
      });

      const result = await executeHermesProductRpcChat({
        ...runInput(fixture.profile, gateway.createClient, readHistoryTail),
      });

      const sourceRangeRef = JSON.stringify({
        version: 1,
        status: "exact",
        sessionId: "hermes-product-session",
        startExclusive: 40,
        endInclusive: 44,
      });
      expect(result).toMatchObject({
        exitCode: 0,
        resultJson: {
          transcriptBoundary: {
            status: "exact",
            sessionId: "hermes-product-session",
            startExclusive: 40,
            endInclusive: 44,
            sourceRangeRef,
          },
        },
      });
      expect(reads).toEqual(["hermes-product-session", "hermes-product-session"]);
    } finally {
      await fixture.cleanup();
    }
  });

  it.each([
    ["no new history rows", [40, 40]],
    ["no trustworthy pre-prompt snapshot", [null, 44]],
  ] as const)("does not claim a complete transcript boundary for %s", async (_case, tails) => {
    const fixture = await makeProfile();
    try {
      const historyTails = [...tails];
      const readHistoryTail: NonNullable<Parameters<typeof executeHermesProductRpcChat>[0]["readHistoryTail"]> = async () => {
        const tailRowId = historyTails.shift();
        return tailRowId === null || tailRowId === undefined
          ? null
          : { availability: "available", tailRowId, relation: "none", successorSessionId: null };
      };
      const gateway = mockGateway((method, _params, emit) => {
        if (method === "prompt.submit") {
          emit("message.start");
          emitTurnComplete(emit);
          return { status: "streaming" };
        }
        return undefined;
      });

      const result = await executeHermesProductRpcChat({
        ...runInput(fixture.profile, gateway.createClient, readHistoryTail),
      });

      expect(result).toMatchObject({
        exitCode: 1,
        errorCode: "hermes_product_rpc_transcript_boundary_unknown",
      });
      expect(result.resultJson).toMatchObject({
        transcriptBoundary: { status: "unknown", sourceRangeRef: null },
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps a provider-failed execution failed even when its partial row interval is exact", async () => {
    const fixture = await makeProfile();
    try {
      const tails = [40, 42];
      const readHistoryTail: NonNullable<Parameters<typeof executeHermesProductRpcChat>[0]["readHistoryTail"]> = async () => ({
        availability: "available",
        tailRowId: tails.shift() ?? null,
        relation: "none",
        successorSessionId: null,
      });
      const gateway = mockGateway((method, _params, emit) => {
        if (method === "prompt.submit") {
          emit("message.start");
          emit("message.complete", { text: "", status: "error", error: "provider rejected the turn" });
          emit("session.info", { running: false });
          return { status: "streaming" };
        }
        return undefined;
      });

      const result = await executeHermesProductRpcChat({
        ...runInput(fixture.profile, gateway.createClient, readHistoryTail),
      });

      expect(result).toMatchObject({
        exitCode: 1,
        errorCode: "hermes_product_rpc_turn_failed",
        resultJson: { transcriptBoundary: { status: "exact", startExclusive: 40, endInclusive: 42 } },
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("does not mark a settled turn complete when Hermes returned no assistant text", async () => {
    const fixture = await makeProfile();
    try {
      const gateway = mockGateway((method, _params, emit) => {
        if (method === "prompt.submit") {
          emit("message.start");
          emit("message.complete", { text: "  ", status: "complete" });
          emit("session.info", { running: false });
          return { status: "streaming" };
        }
        return undefined;
      });

      const result = await executeHermesProductRpcChat({
        ...runInput(fixture.profile, gateway.createClient),
      });

      expect(result).toMatchObject({
        exitCode: 1,
        errorCode: "hermes_product_rpc_empty_output",
        resultJson: { transcriptBoundary: { status: "exact" } },
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("refuses to submit a fresh turn without Hermes' persisted session key", async () => {
    const fixture = await makeProfile();
    try {
      const gateway = mockGateway((method) => method === "session.create"
        ? { session_id: "hermes-product-runtime-1" }
        : undefined);
      const result = await executeHermesProductRpcChat({
        ...runInput(fixture.profile, gateway.createClient),
      });

      expect(result).toMatchObject({
        exitCode: 1,
        errorMessage: "Hermes Product Gateway session.create returned no persisted stored_session_id.",
      });
      expect(gateway.calls.some(({ method }) => method === "prompt.submit")).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it("resumes only a session pinned to the same Product Gateway profile", async () => {
    const fixture = await makeProfile();
    try {
      const gateway = mockGateway((method, _params, emit) => {
        if (method === "prompt.submit") {
          emit("message.start");
          emitTurnComplete(emit);
          return { status: "streaming" };
        }
        return undefined;
      });
      const sessionParams = buildHermesProductRpcSessionParams({
        sessionId: "hermes-product-session",
        profile: fixture.profile,
      });
      const resumed = await executeHermesProductRpcChat({
        ...runInput(fixture.profile, gateway.createClient),
        sessionId: "hermes-product-session",
        sessionParams,
      });

      expect(resumed).toMatchObject({ exitCode: 0, sessionId: "hermes-product-session" });
      expect(gateway.calls.find(({ method }) => method === "session.resume")?.params).toEqual({
        session_id: "hermes-product-session",
        lazy: true,
      });
      expect(gateway.calls.some(({ method }) => method === "session.info")).toBe(false);
      expect(gateway.calls.find(({ method }) => method === "prompt.submit")?.params).toMatchObject({
        session_id: "hermes-product-runtime-resumed",
      });
      expect(resumed.resultJson).toMatchObject({
        transcriptBoundary: { status: "exact", sessionId: "hermes-product-session", startExclusive: 40, endInclusive: 44 },
      });

      const otherGateway = mockGateway();
      const rejected = await executeHermesProductRpcChat({
        ...runInput(fixture.profile, otherGateway.createClient),
        sessionId: "hermes-product-session",
        sessionParams: { ...sessionParams, transport: "hermes-acp-stdio" },
      });
      expect(rejected.errorMessage).toContain("transport is not the Product Gateway");
      expect(otherGateway.calls).toHaveLength(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it.each([
    { name: "running", running: true, expectedMessage: "session is already running" },
    { name: "unknown running state", expectedMessage: "did not report the session running state" },
  ])("does not submit a resumed turn when Gateway reports $name", async ({ running, expectedMessage }) => {
    const fixture = await makeProfile();
    try {
      const gateway = mockGateway((method, params) => method === "session.resume"
        ? {
          session_id: "hermes-product-runtime-resumed",
          session_key: params.session_id,
          ...(running === undefined ? {} : { running }),
        }
        : undefined);
      const sessionParams = buildHermesProductRpcSessionParams({
        sessionId: "hermes-product-session",
        profile: fixture.profile,
      });

      const result = await executeHermesProductRpcChat({
        ...runInput(fixture.profile, gateway.createClient),
        sessionId: "hermes-product-session",
        sessionParams,
      });

      expect(result.errorMessage).toContain(expectedMessage);
      expect(gateway.calls.some(({ method }) => method === "prompt.submit")).toBe(false);
      expect(gateway.calls.some(({ method }) => method === "session.info")).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it("bridges clarify answers and cancels secret input without exposing values", async () => {
    const fixture = await makeProfile();
    try {
      let clarification: AgentRuntimeApprovalRequest | null = null;
      const logs: string[] = [];
      const gateway = mockGateway((method, _params, emit) => {
        if (method === "prompt.submit") {
          emit("message.start");
          emit("clarify.request", {
            request_id: "clarify-provider-21",
            questions: [{ qid: "provider-q1", question: "Which mode?", choices: ["fast", "safe"] }],
          });
          return { status: "streaming" };
        }
        if (method === "clarify.respond") {
          emitTurnComplete(emit);
          return { status: "ok" };
        }
        return undefined;
      });
      const result = await executeHermesProductRpcChat({
        ...runInput(fixture.profile, gateway.createClient),
        requestApproval: async (request) => {
          clarification = request;
          return { id: "rudder-clarify-21", status: "pending" };
        },
        waitForApproval: async (id) => ({
          id,
          status: "approved",
          inputResponse: { answers: [{ questionId: "hermes_clarify_1", optionIds: ["hermes_clarify_1_option_2"] }] },
        } satisfies AgentRuntimeApprovalDecision),
        onLog: async (_stream, chunk) => { logs.push(chunk); },
      });

      expect(result.exitCode).toBe(0);
      expect(clarification).toMatchObject({ payload: { interactionKind: "clarify" } });
      expect(gateway.calls.find(({ method }) => method === "clarify.respond")?.params).toMatchObject({
        session_id: "hermes-product-runtime-1",
        request_id: "clarify-provider-21",
        question_id: "provider-q1",
        answer: "safe",
      });

      const secretGateway = mockGateway((method, _params, emit) => {
        if (method === "prompt.submit") {
          emit("message.start");
          emit("secret.request", { request_id: "secret-provider-9", value: "sensitive-hermes-value" });
          return { status: "streaming" };
        }
        if (method === "secret.respond") {
          emitTurnComplete(emit);
          return { status: "ok" };
        }
        return undefined;
      });
      const secretResult = await executeHermesProductRpcChat({
        ...runInput(fixture.profile, secretGateway.createClient),
        onLog: async (_stream, chunk) => { logs.push(chunk); },
      });
      expect(secretResult).toMatchObject({
        exitCode: 1,
        errorCode: "hermes_product_rpc_sensitive_input_unavailable",
      });
      expect(secretGateway.calls.find(({ method }) => method === "secret.respond")?.params).toEqual({
        request_id: "secret-provider-9",
        value: "",
      });
      expect(logs.join("\n")).not.toContain("sensitive-hermes-value");
    } finally {
      await fixture.cleanup();
    }
  });

  it("uses native redirect and waits for terminal state after Stop", async () => {
    const fixture = await makeProfile();
    try {
      let publishHandle!: (handle: AgentRuntimeControlHandle) => void;
      let markStarted!: () => void;
      const handleReady = new Promise<AgentRuntimeControlHandle>((resolve) => { publishHandle = resolve; });
      const promptStarted = new Promise<void>((resolve) => { markStarted = resolve; });
      const controlAttempt: AgentRuntimeControlAttemptLease = {
        attemptEpoch: 1,
        ownerToken: "hermes-product-rpc-test",
        async register(handle) {
          publishHandle(handle);
          return { isCurrent: () => true, release: async () => handle.dispose() };
        },
        async complete() {},
      };
      const gateway = mockGateway((method, _params, emit) => {
        if (method === "prompt.submit") {
          emit("message.start");
          markStarted();
          return { status: "streaming" };
        }
        if (method === "session.interrupt") {
          setTimeout(() => emitTurnComplete(emit, "interrupted"), 0);
          return { status: "interrupted" };
        }
        return undefined;
      });
      const execution = executeHermesProductRpcChat({
        ...runInput(fixture.profile, gateway.createClient),
        controlAttempt,
      });
      const handle = await handleReady;
      await promptStarted;

      await expect(handle.steer({ text: "Focus on the failing test.", clientMessageId: "message-1" })).resolves.toMatchObject({
        disposition: "accepted_current",
        providerThreadId: "hermes-product-session",
      });
      await expect(handle.interrupt("operator_stop")).resolves.toBe("waiting_safe_boundary");
      const result = await execution;

      expect(gateway.calls.find(({ method }) => method === "session.redirect")?.params).toEqual({
        session_id: "hermes-product-runtime-1",
        text: "Focus on the failing test.",
      });
      expect(result).toMatchObject({
        exitCode: 1,
        signal: "SIGTERM",
        errorCode: "hermes_product_rpc_interrupted",
        resultJson: { control: { interruptRequested: true, stopConfirmed: true } },
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("does not close the Gateway immediately when the execution is aborted", async () => {
    const fixture = await makeProfile();
    try {
      const controller = new AbortController();
      const gateway = mockGateway((method, _params, emit) => {
        if (method === "prompt.submit") {
          emit("message.start");
          return { status: "streaming" };
        }
        if (method === "session.interrupt") {
          setTimeout(() => emitTurnComplete(emit, "interrupted"), 0);
          return { status: "interrupted" };
        }
        return undefined;
      });
      const resultPromise = executeHermesProductRpcChat({
        ...runInput(fixture.profile, gateway.createClient),
        signal: controller.signal,
      });
      await vi.waitFor(() => expect(gateway.calls.some(({ method }) => method === "prompt.submit")).toBe(true));
      controller.abort();
      const result = await resultPromise;

      expect(result).toMatchObject({
        exitCode: 1,
        signal: "SIGTERM",
        errorCode: "hermes_product_rpc_interrupted",
      });
      expect(gateway.timeline.indexOf("session.interrupt")).toBeLessThan(gateway.timeline.indexOf("close"));
      expect(gateway.timeline.indexOf("session.info")).toBeLessThan(gateway.timeline.indexOf("close"));
    } finally {
      await fixture.cleanup();
    }
  });
});
