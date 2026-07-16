import type { ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export type CodexAppServerRequestId = string | number;
export type CodexAppServerClientState = "new" | "initializing" | "ready" | "closed" | "failed";

export interface CodexAppServerTransportExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

export interface CodexAppServerTransport {
  write(serializedMessage: string): void;
  onStdout(listener: (chunk: Buffer | Uint8Array | string) => void): () => void;
  onExit(listener: (exit: CodexAppServerTransportExit) => void): () => void;
  terminate?(): void;
}

export interface CodexAppServerClientInfo {
  name: string;
  title?: string;
  version: string;
}

export interface CodexAppServerNotification {
  method: string;
  params?: unknown;
}

export interface CodexAppServerNotificationContext {
  signal: AbortSignal;
}

export interface CodexAppServerServerRequest {
  id: CodexAppServerRequestId;
  method: string;
  params?: unknown;
}

export interface CodexAppServerServerRequestContext extends CodexAppServerServerRequest {
  signal: AbortSignal;
}

export type CodexAppServerServerRequestHandler = (
  request: CodexAppServerServerRequestContext,
) => unknown | Promise<unknown>;

export interface CodexAppServerClientOptions {
  transport: CodexAppServerTransport;
  clientInfo: CodexAppServerClientInfo;
  capabilities?: Record<string, unknown> | null;
  requestTimeoutMs?: number;
  serverRequestTimeoutMs?: number;
  notificationDrainTimeoutMs?: number;
  maxServerRequestIds?: number;
  maxFrameBytes?: number;
  abortSignal?: AbortSignal;
  serverRequestHandlers?: Readonly<Record<string, CodexAppServerServerRequestHandler>>;
  onNotification?: (
    notification: CodexAppServerNotification,
    context: CodexAppServerNotificationContext,
  ) => void | Promise<void>;
  onCapabilityGateClosed?: (error: CodexAppServerProtocolError) => void;
  onError?: (error: Error) => void;
}

interface PendingClientRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface PendingServerRequest {
  id: CodexAppServerRequestId;
  key: string;
  method: string;
  controller: AbortController;
  timer: NodeJS.Timeout;
  responded: boolean;
}

interface RpcErrorShape {
  code: number;
  message: string;
  data?: unknown;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_SERVER_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_NOTIFICATION_DRAIN_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_SERVER_REQUEST_IDS = 65_536;
const MAX_COMPLETED_CLIENT_REQUEST_IDS = 1_024;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;
const SERVER_REQUEST_TIMEOUT = -32000;

function asPositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.floor(value))
    : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is CodexAppServerRequestId {
  return typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value));
}

function serverRequestKey(id: CodexAppServerRequestId): string {
  return `${typeof id}:${String(id)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class CodexAppServerProtocolError extends Error {
  override readonly name = "CodexAppServerProtocolError";
}

export class CodexAppServerClosedError extends Error {
  override readonly name = "CodexAppServerClosedError";
}

export class CodexAppServerTimeoutError extends Error {
  override readonly name = "CodexAppServerTimeoutError";
}

export class CodexAppServerRpcError extends Error {
  override readonly name = "CodexAppServerRpcError";
  readonly code: number;
  readonly data: unknown;

  constructor(error: RpcErrorShape) {
    super(error.message);
    this.code = error.code;
    this.data = error.data;
  }
}

class CodexAppServerJsonlFramer {
  private decoder = new StringDecoder("utf8");
  private buffer = "";

  constructor(private readonly maxFrameBytes: number) {}

  push(chunk: Buffer | Uint8Array | string): string[] {
    if (typeof chunk === "string") {
      const incompleteBinary = this.decoder.end();
      this.decoder = new StringDecoder("utf8");
      if (incompleteBinary.length > 0) {
        throw new CodexAppServerProtocolError(
          "Codex app-server transport changed chunk type during an incomplete UTF-8 sequence",
        );
      }
      this.buffer += chunk;
    } else {
      this.buffer += this.decoder.write(Buffer.from(chunk));
    }
    return this.drain(false);
  }

  finish(): string[] {
    this.buffer += this.decoder.end();
    return this.drain(true);
  }

  private drain(includeRemainder: boolean): string[] {
    const lines: string[] = [];
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      this.assertFrameSize(line);
      if (line.trim().length > 0) lines.push(line);
    }

    if (includeRemainder && this.buffer.trim().length > 0) {
      const line = this.buffer.replace(/\r$/, "");
      this.buffer = "";
      this.assertFrameSize(line);
      lines.push(line);
    } else {
      this.assertFrameSize(this.buffer);
    }
    return lines;
  }

  private assertFrameSize(value: string): void {
    if (Buffer.byteLength(value, "utf8") > this.maxFrameBytes) {
      throw new CodexAppServerProtocolError(
        `Codex app-server JSONL frame exceeded ${this.maxFrameBytes} bytes`,
      );
    }
  }
}

export function createCodexAppServerStdioTransport(child: ChildProcess): CodexAppServerTransport {
  if (!child.stdin || !child.stdout) {
    throw new Error("Codex app-server child requires piped stdin and stdout");
  }

  const swallowDetachedStdinError = () => undefined;
  child.stdin.on("error", swallowDetachedStdinError);

  return {
    write(serializedMessage) {
      if (!child.stdin?.writable) throw new CodexAppServerClosedError("Codex app-server stdin is not writable");
      child.stdin.write(serializedMessage);
    },
    onStdout(listener) {
      const onData = (chunk: Buffer | string) => listener(chunk);
      child.stdout?.on("data", onData);
      return () => child.stdout?.off("data", onData);
    },
    onExit(listener) {
      let settled = false;
      const cleanup = () => {
        child.off("close", onClose);
        child.off("error", onProcessError);
        child.stdin?.off("error", onStdinError);
      };
      const finish = (exit: CodexAppServerTransportExit) => {
        if (settled) return;
        settled = true;
        cleanup();
        listener(exit);
      };
      const onClose = (code: number | null, signal: NodeJS.Signals | null) => finish({ code, signal });
      const onProcessError = (error: Error) => finish({ code: null, signal: null, error });
      const onStdinError = (error: Error) => finish({ code: null, signal: null, error });
      child.once("close", onClose);
      child.once("error", onProcessError);
      child.stdin?.once("error", onStdinError);
      return cleanup;
    },
    terminate() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    },
  };
}

export class CodexAppServerClient {
  private readonly transport: CodexAppServerTransport;
  private readonly options: CodexAppServerClientOptions;
  private readonly framer: CodexAppServerJsonlFramer;
  private readonly requestTimeoutMs: number;
  private readonly serverRequestTimeoutMs: number;
  private readonly notificationDrainTimeoutMs: number;
  private readonly maxServerRequestIds: number;
  private readonly serverRequestHandlers: Map<string, CodexAppServerServerRequestHandler>;
  private readonly pendingClientRequests = new Map<CodexAppServerRequestId, PendingClientRequest>();
  private readonly completedClientRequestIds = new Map<CodexAppServerRequestId, true>();
  private readonly pendingServerRequests = new Map<string, PendingServerRequest>();
  private readonly completedServerRequestIds = new Map<string, true>();
  private notificationChain: Promise<void> = Promise.resolve();
  private readonly notificationAbortController = new AbortController();
  private nextRequestId = 1;
  private stateValue: CodexAppServerClientState = "new";
  private protocolCompatibleValue = true;
  private capabilityGateErrorValue: CodexAppServerProtocolError | null = null;
  private initializePromise: Promise<unknown> | null = null;
  private closing = false;
  private transportOpen = true;
  private removeStdoutListener: (() => void) | null = null;
  private removeExitListener: (() => void) | null = null;
  private removeAbortListener: (() => void) | null = null;

  constructor(options: CodexAppServerClientOptions) {
    this.options = options;
    this.transport = options.transport;
    this.requestTimeoutMs = asPositiveInteger(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    this.serverRequestTimeoutMs = asPositiveInteger(
      options.serverRequestTimeoutMs,
      DEFAULT_SERVER_REQUEST_TIMEOUT_MS,
    );
    this.notificationDrainTimeoutMs = asPositiveInteger(
      options.notificationDrainTimeoutMs,
      DEFAULT_NOTIFICATION_DRAIN_TIMEOUT_MS,
    );
    this.maxServerRequestIds = asPositiveInteger(
      options.maxServerRequestIds,
      DEFAULT_MAX_SERVER_REQUEST_IDS,
    );
    this.framer = new CodexAppServerJsonlFramer(
      asPositiveInteger(options.maxFrameBytes, DEFAULT_MAX_FRAME_BYTES),
    );
    this.serverRequestHandlers = new Map(Object.entries(options.serverRequestHandlers ?? {}));
    this.removeStdoutListener = this.transport.onStdout((chunk) => this.handleStdout(chunk));
    this.removeExitListener = this.transport.onExit((exit) => this.handleExit(exit));

    if (options.abortSignal) {
      const onAbort = () => {
        const reason = options.abortSignal?.reason;
        const error = reason instanceof Error
          ? reason
          : new CodexAppServerClosedError(`Codex app-server client aborted${reason === undefined ? "" : `: ${String(reason)}`}`);
        this.shutdown(error, "closed", true, true);
      };
      if (options.abortSignal.aborted) {
        onAbort();
      } else {
        options.abortSignal.addEventListener("abort", onAbort, { once: true });
        this.removeAbortListener = () => options.abortSignal?.removeEventListener("abort", onAbort);
      }
    }
  }

  get state(): CodexAppServerClientState {
    return this.stateValue;
  }

  get protocolCompatible(): boolean {
    return this.protocolCompatibleValue;
  }

  get capabilityGateError(): CodexAppServerProtocolError | null {
    return this.capabilityGateErrorValue;
  }

  get pendingRequestCount(): number {
    return this.pendingClientRequests.size;
  }

  get pendingServerRequestCount(): number {
    return this.pendingServerRequests.size;
  }

  initialize(): Promise<unknown> {
    if (this.initializePromise) return this.initializePromise;
    if (this.stateValue !== "new") {
      return Promise.reject(new CodexAppServerClosedError(`Cannot initialize client in state ${this.stateValue}`));
    }

    this.stateValue = "initializing";
    this.initializePromise = this.sendRequest("initialize", {
      clientInfo: this.options.clientInfo,
      capabilities: this.options.capabilities ?? null,
    }, this.requestTimeoutMs)
      .then((result) => {
        if (this.closing) throw new CodexAppServerClosedError("Codex app-server closed during initialize");
        this.writeMessage({ method: "initialized", params: {} });
        this.stateValue = "ready";
        return result;
      })
      .catch((error: unknown) => {
        const normalized = error instanceof Error ? error : new Error(String(error));
        this.shutdown(normalized, "failed", true, true);
        throw normalized;
      });
    return this.initializePromise;
  }

  request<TResult = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<TResult> {
    if (this.closing || this.stateValue !== "ready") {
      return Promise.reject(new CodexAppServerClosedError(`Cannot request ${method} in state ${this.stateValue}`));
    }
    return this.sendRequest(method, params, asPositiveInteger(timeoutMs, this.requestTimeoutMs)) as Promise<TResult>;
  }

  notify(method: string, params?: unknown): void {
    if (this.closing || this.stateValue !== "ready") {
      throw new CodexAppServerClosedError(`Cannot notify ${method} in state ${this.stateValue}`);
    }
    this.writeMessage(params === undefined ? { method } : { method, params });
  }

  dispose(reason = "Codex app-server client disposed"): void {
    this.shutdown(new CodexAppServerClosedError(reason), "closed", true, true);
  }

  private sendRequest(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingClientRequests.delete(id);
        this.rememberCompletedClientRequest(id);
        reject(new CodexAppServerTimeoutError(`Codex app-server timed out on ${method}`));
      }, timeoutMs);
      this.pendingClientRequests.set(id, { method, resolve, reject, timer });
      try {
        this.writeMessage(params === undefined ? { id, method } : { id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pendingClientRequests.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private writeMessage(message: unknown): void {
    if (this.closing || !this.transportOpen) {
      throw new CodexAppServerClosedError("Codex app-server transport is closed");
    }
    const serialized = `${JSON.stringify(message)}\n`;
    try {
      this.transport.write(serialized);
    } catch (writeError) {
      const error = writeError instanceof Error ? writeError : new Error(String(writeError));
      this.shutdown(error, "failed", true, true);
      throw error;
    }
  }

  private handleStdout(chunk: Buffer | Uint8Array | string): void {
    if (this.closing) return;
    let lines: string[];
    try {
      lines = this.framer.push(chunk);
    } catch (error) {
      this.failProtocol(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    for (const line of lines) {
      if (this.closing) break;
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.failProtocol(new CodexAppServerProtocolError(`Invalid JSON from Codex app-server: ${line.slice(0, 200)}`));
      return;
    }
    if (!isRecord(parsed)) {
      this.failProtocol(new CodexAppServerProtocolError("Codex app-server message must be an object"));
      return;
    }

    const hasMethod = Object.hasOwn(parsed, "method");
    const hasId = Object.hasOwn(parsed, "id");
    const hasResult = Object.hasOwn(parsed, "result");
    const hasError = Object.hasOwn(parsed, "error");

    if (hasMethod) {
      if (typeof parsed.method !== "string" || parsed.method.length === 0 || hasResult || hasError) {
        this.failProtocol(new CodexAppServerProtocolError("Malformed Codex app-server request or notification"));
        return;
      }
      if (!hasId) {
        this.handleNotification({
          method: parsed.method,
          ...(Object.hasOwn(parsed, "params") ? { params: parsed.params } : {}),
        });
        return;
      }
      if (!isRequestId(parsed.id)) {
        this.failProtocol(new CodexAppServerProtocolError("Codex app-server request id must be a string or safe integer"));
        return;
      }
      this.handleServerRequest({
        id: parsed.id,
        method: parsed.method,
        ...(Object.hasOwn(parsed, "params") ? { params: parsed.params } : {}),
      });
      return;
    }

    if (hasId && isRequestId(parsed.id) && hasResult !== hasError) {
      this.handleResponse(parsed.id, parsed);
      return;
    }
    this.failProtocol(new CodexAppServerProtocolError("Unclassifiable message from Codex app-server"));
  }

  private handleResponse(id: CodexAppServerRequestId, response: Record<string, unknown>): void {
    const pending = this.pendingClientRequests.get(id);
    if (!pending) {
      if (this.completedClientRequestIds.has(id)) return;
      this.failProtocol(new CodexAppServerProtocolError(
        `Codex app-server responded with unknown request id ${String(id)}`,
      ));
      return;
    }
    clearTimeout(pending.timer);
    this.pendingClientRequests.delete(id);
    this.rememberCompletedClientRequest(id);

    if (Object.hasOwn(response, "error")) {
      if (
        !isRecord(response.error)
        || !Number.isSafeInteger(response.error.code)
        || typeof response.error.message !== "string"
      ) {
        const error = new CodexAppServerProtocolError(
          `Codex app-server response ${String(id)} has an invalid error object`,
        );
        pending.reject(error);
        this.failProtocol(error);
        return;
      }
      pending.reject(new CodexAppServerRpcError({
        code: response.error.code as number,
        message: response.error.message,
        data: response.error.data,
      }));
      return;
    }
    if (!Object.hasOwn(response, "result")) {
      const error = new CodexAppServerProtocolError(
        `Codex app-server response ${String(id)} has neither result nor error`,
      );
      pending.reject(error);
      this.failProtocol(error);
      return;
    }
    pending.resolve(response.result);
  }

  private handleNotification(notification: CodexAppServerNotification): void {
    if (!this.options.onNotification) return;
    const signal = this.notificationAbortController.signal;
    this.notificationChain = this.notificationChain.then(async () => {
      if (signal.aborted) return;
      try {
        await this.options.onNotification?.(notification, { signal });
      } catch (error) {
        this.reportError(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private handleServerRequest(request: CodexAppServerServerRequest): void {
    const key = serverRequestKey(request.id);
    if (this.pendingServerRequests.has(key) || this.completedServerRequestIds.has(key)) return;
    if (this.pendingServerRequests.size + this.completedServerRequestIds.size >= this.maxServerRequestIds) {
      const protocolError = new CodexAppServerProtocolError(
        `Codex app-server exceeded ${this.maxServerRequestIds} unique server request ids`,
      );
      try {
        this.writeMessage({
          id: request.id,
          error: { code: INTERNAL_ERROR, message: protocolError.message },
        });
      } catch {
        // failProtocol closes the transport below.
      }
      this.failProtocol(protocolError);
      return;
    }

    const controller = new AbortController();
    const pending: PendingServerRequest = {
      id: request.id,
      key,
      method: request.method,
      controller,
      responded: false,
      timer: setTimeout(() => {
        controller.abort(new CodexAppServerTimeoutError(`Server request ${request.method} timed out`));
        this.respondToServerRequest(pending, undefined, {
          code: SERVER_REQUEST_TIMEOUT,
          message: `Client handler timed out for ${request.method}`,
        });
      }, this.serverRequestTimeoutMs),
    };
    this.pendingServerRequests.set(key, pending);

    const handler = this.serverRequestHandlers.get(request.method);
    if (!handler) {
      const protocolError = new CodexAppServerProtocolError(
        `Unsupported Codex app-server request method: ${request.method}`,
      );
      this.respondToServerRequest(pending, undefined, {
        code: METHOD_NOT_FOUND,
        message: `Client does not handle method \"${request.method}\"`,
      });
      this.failProtocol(protocolError);
      return;
    }

    void Promise.resolve()
      .then(() => handler({ ...request, signal: controller.signal }))
      .then((result) => this.respondToServerRequest(pending, result))
      .catch((error: unknown) => this.respondToServerRequest(pending, undefined, {
        code: INTERNAL_ERROR,
        message: errorMessage(error),
      }));
  }

  private respondToServerRequest(
    pending: PendingServerRequest,
    result?: unknown,
    error?: RpcErrorShape,
  ): void {
    if (pending.responded) return;
    let serialized: string;
    try {
      serialized = `${JSON.stringify(error
        ? { id: pending.id, error }
        : { id: pending.id, result: result ?? null })}\n`;
    } catch {
      serialized = `${JSON.stringify({
        id: pending.id,
        error: { code: INTERNAL_ERROR, message: `Client returned a non-serializable result for ${pending.method}` },
      })}\n`;
    }

    pending.responded = true;
    clearTimeout(pending.timer);
    this.pendingServerRequests.delete(pending.key);
    this.rememberCompletedServerRequest(pending.key);
    try {
      if (this.transportOpen) this.transport.write(serialized);
    } catch (writeError) {
      this.shutdown(
        writeError instanceof Error ? writeError : new Error(String(writeError)),
        "failed",
        true,
        false,
      );
    }
  }

  private rememberCompletedServerRequest(key: string): void {
    this.completedServerRequestIds.set(key, true);
  }

  private rememberCompletedClientRequest(id: CodexAppServerRequestId): void {
    this.completedClientRequestIds.delete(id);
    this.completedClientRequestIds.set(id, true);
    if (this.completedClientRequestIds.size <= MAX_COMPLETED_CLIENT_REQUEST_IDS) return;
    const oldest = this.completedClientRequestIds.keys().next().value as CodexAppServerRequestId | undefined;
    if (oldest !== undefined) this.completedClientRequestIds.delete(oldest);
  }

  private handleExit(exit: CodexAppServerTransportExit): void {
    if (this.closing) return;
    try {
      for (const line of this.framer.finish()) this.handleLine(line);
    } catch (error) {
      this.failProtocol(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (this.closing) return;
    const detail = exit.error?.message
      ?? (exit.signal ? `signal ${exit.signal}` : `code ${exit.code ?? -1}`);
    this.shutdown(
      new CodexAppServerClosedError(`Codex app-server exited with ${detail}`),
      "closed",
      false,
      false,
      false,
      true,
    );
  }

  private failProtocol(error: Error): void {
    const protocolError = error instanceof CodexAppServerProtocolError
      ? error
      : new CodexAppServerProtocolError(error.message);
    const capabilityGateClosed = this.closeCapabilityGate(protocolError);
    this.shutdown(protocolError, "failed", true, true);
    if (capabilityGateClosed) this.notifyCapabilityGateClosed(protocolError);
  }

  private closeCapabilityGate(error: CodexAppServerProtocolError): boolean {
    if (!this.protocolCompatibleValue) return false;
    this.protocolCompatibleValue = false;
    this.capabilityGateErrorValue = error;
    return true;
  }

  private notifyCapabilityGateClosed(error: CodexAppServerProtocolError): void {
    try {
      this.options.onCapabilityGateClosed?.(error);
    } catch (callbackError) {
      this.reportError(
        callbackError instanceof Error ? callbackError : new Error(String(callbackError)),
      );
    }
  }

  private shutdown(
    error: Error,
    terminalState: "closed" | "failed",
    terminate: boolean,
    respondToServerRequests: boolean,
    cancelNotifications = true,
    reportAfterNotificationDrain = false,
  ): void {
    if (this.closing) return;
    this.closing = true;
    this.stateValue = terminalState;
    if (cancelNotifications && !this.notificationAbortController.signal.aborted) {
      this.notificationAbortController.abort(error);
    }

    for (const [id, pending] of this.pendingClientRequests) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pendingClientRequests.delete(id);
    }
    for (const pending of [...this.pendingServerRequests.values()]) {
      pending.controller.abort(error);
      if (respondToServerRequests && this.transportOpen) {
        this.respondToServerRequest(pending, undefined, { code: INTERNAL_ERROR, message: error.message });
      } else {
        pending.responded = true;
        clearTimeout(pending.timer);
        this.pendingServerRequests.delete(pending.key);
        this.rememberCompletedServerRequest(pending.key);
      }
    }

    this.transportOpen = false;
    this.removeStdoutListener?.();
    this.removeExitListener?.();
    this.removeAbortListener?.();
    this.removeStdoutListener = null;
    this.removeExitListener = null;
    this.removeAbortListener = null;
    if (terminate) {
      try {
        this.transport.terminate?.();
      } catch (terminateError) {
        this.reportError(
          terminateError instanceof Error ? terminateError : new Error(String(terminateError)),
        );
      }
    }
    if (reportAfterNotificationDrain) {
      this.finishNotificationDrain(error);
    } else {
      this.reportError(error);
    }
  }

  private finishNotificationDrain(error: Error): void {
    let timer: NodeJS.Timeout | null = null;
    const timeout = new Promise<"timed_out">((resolve) => {
      timer = setTimeout(() => resolve("timed_out"), this.notificationDrainTimeoutMs);
    });
    const drained = this.notificationChain.then(() => "drained" as const);
    void Promise.race([drained, timeout]).then((outcome) => {
      if (timer) clearTimeout(timer);
      if (outcome === "timed_out" && !this.notificationAbortController.signal.aborted) {
        this.notificationAbortController.abort(error);
      }
      this.reportError(error);
    });
  }

  private reportError(error: Error): void {
    try {
      this.options.onError?.(error);
    } catch {
      // User callbacks cannot compromise transport cleanup.
    }
  }
}
