import {
  Client,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type AuthProvider,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/client";
import {
  DEFAULT_INHERITED_ENV_VARS,
  StdioClientTransport,
} from "@modelcontextprotocol/client/stdio";
import type { DeploymentMode } from "@rudderhq/shared";
import { createSecureMcpFetch } from "./pinned-fetch.js";
import {
  assertSafeMcpCredentialHeaders,
  assertSafeMcpHeaders,
  validateMcpStdioPolicy,
  type McpDnsLookup,
} from "./security-policy.js";

export class ManagedMcpClientError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ManagedMcpClientError";
    this.code = code;
  }
}

export interface ManagedMcpOAuthCredential {
  token(): Promise<string>;
  refresh(): Promise<void>;
}

export interface ResolvedMcpHttpCredentials {
  headers: Record<string, string>;
  authProvider?: AuthProvider;
}

export function resolveMcpHttpCredentials(input: {
  bearerToken?: string;
  authorizationHeader?: string;
  secretHeaders?: Record<string, string>;
  oauth?: ManagedMcpOAuthCredential;
}): ResolvedMcpHttpCredentials {
  assertSafeMcpCredentialHeaders(input.secretHeaders ?? {});
  const encryptedAuthorization = Object.entries(input.secretHeaders ?? {})
    .find(([name]) => name.toLowerCase() === "authorization");
  const authorizationSources = [
    Boolean(input.bearerToken),
    Boolean(input.authorizationHeader),
    Boolean(encryptedAuthorization),
    Boolean(input.oauth),
  ].filter(Boolean).length;
  if (authorizationSources > 1) {
    throw new ManagedMcpClientError(
      "mcp_conflicting_authorization",
      "Configure exactly one managed MCP Authorization source",
    );
  }

  const headers = { ...(input.secretHeaders ?? {}) };
  if (input.bearerToken) headers.Authorization = `Bearer ${input.bearerToken}`;
  if (input.authorizationHeader) headers.Authorization = input.authorizationHeader;
  return {
    headers,
    authProvider: input.oauth
      ? {
        token: () => input.oauth!.token(),
        onUnauthorized: async () => input.oauth!.refresh(),
      }
      : undefined,
  };
}

interface ManagedMcpClientCommonOptions {
  startupTimeoutMs: number;
  toolTimeoutMs: number;
  maxOutputBytes?: number;
}

export interface ManagedMcpHttpClientOptions extends ManagedMcpClientCommonOptions {
  transport: "streamable_http";
  url: string;
  staticHeaders?: Record<string, string>;
  credentials: ResolvedMcpHttpCredentials;
  network: {
    allowedOrigins: string[];
    curatedOrigin?: string;
    lookup?: McpDnsLookup;
  };
}

export interface ManagedMcpStdioClientOptions extends ManagedMcpClientCommonOptions {
  transport: "stdio";
  command: string;
  args?: string[];
  cwd?: string;
  staticEnv: Record<string, string>;
  forwardedEnv: string[];
  secretEnv: Record<string, string>;
  hostEnv: Record<string, string | undefined>;
  deploymentPolicy: {
    deploymentMode: DeploymentMode;
    stdioCommands: string[][];
    stdioWorkingDirectories: string[];
    stdioEnvironmentNames: string[];
  };
}

export type ManagedMcpClientOptions =
  | ManagedMcpHttpClientOptions
  | ManagedMcpStdioClientOptions;

export interface ManagedMcpClient {
  discoverTools(): Promise<Tool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}

const STDIO_CLOSE_GRACE_MS = 200;
const STDIO_KILL_WAIT_MS = 750;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // The child already exited.
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isProcessAlive(pid) && Date.now() < deadline) {
    await delay(10);
  }
  return !isProcessAlive(pid);
}

async function closeManagedStdioTransport(
  transport: StdioClientTransport,
  trackedPid: number | null,
): Promise<void> {
  const pid = transport.pid ?? trackedPid;
  const closePromise = transport.close().catch(() => undefined);
  if (pid === null || !isProcessAlive(pid)) {
    await closePromise;
    return;
  }

  await Promise.race([closePromise, delay(STDIO_CLOSE_GRACE_MS)]);
  if (isProcessAlive(pid)) signalProcess(pid, "SIGTERM");
  await Promise.race([closePromise, delay(STDIO_CLOSE_GRACE_MS)]);
  if (isProcessAlive(pid)) signalProcess(pid, "SIGKILL");

  if (!(await waitForProcessExit(pid, STDIO_KILL_WAIT_MS))) {
    throw new ManagedMcpClientError(
      "mcp_process_cleanup_failed",
      "Managed MCP STDIO process could not be terminated",
    );
  }
}

function isStdioOutputBoundaryError(error: unknown): boolean {
  return error instanceof Error && /ReadBuffer exceeded maximum size/u.test(error.message);
}

function safeClientError(error: unknown, action: "connect" | "discover" | "call"): ManagedMcpClientError {
  if (error instanceof ManagedMcpClientError) return error;
  if (error instanceof UnauthorizedError || (error instanceof SdkHttpError && error.status === 401)) {
    return new ManagedMcpClientError(
      "mcp_upstream_unauthorized",
      "Managed MCP authorization was rejected",
    );
  }
  if (error instanceof SdkHttpError && error.status === 429) {
    return new ManagedMcpClientError(
      "mcp_upstream_rate_limited",
      "Managed MCP upstream rate limit was reached",
    );
  }
  if (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout) {
    return new ManagedMcpClientError(
      action === "call" ? "mcp_tool_timeout" : "mcp_startup_timeout",
      action === "call"
        ? "Managed MCP tool call timed out"
        : "Managed MCP connection timed out",
    );
  }
  return new ManagedMcpClientError(
    action === "call" ? "mcp_tool_failed" : "mcp_transport_failed",
    action === "call"
      ? "Managed MCP tool call failed"
      : "Managed MCP transport failed",
  );
}

function boundedResult(result: CallToolResult, maxOutputBytes: number): CallToolResult {
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
  } catch {
    throw new ManagedMcpClientError(
      "mcp_result_invalid",
      "Managed MCP tool result is not JSON serializable",
    );
  }
  if (bytes > maxOutputBytes) {
    throw new ManagedMcpClientError(
      "mcp_result_too_large",
      "Managed MCP tool result exceeds the output limit",
    );
  }
  return result;
}

async function prepareStdioLaunch(options: ManagedMcpStdioClientOptions): Promise<{
  command: string;
  cwd: string | undefined;
  env: Record<string, string>;
}> {
  const environmentNames = new Set([
    ...Object.keys(options.staticEnv),
    ...Object.keys(options.secretEnv),
    ...options.forwardedEnv,
  ]);
  const target = await validateMcpStdioPolicy({
    command: options.command,
    args: options.args,
    cwd: options.cwd,
    environmentNames: [...environmentNames],
  }, options.deploymentPolicy);

  const env: Record<string, string> = {
    ...options.staticEnv,
    ...options.secretEnv,
  };
  for (const name of options.forwardedEnv) {
    const value = options.hostEnv[name];
    if (value !== undefined) env[name] = value;
  }

  if (options.deploymentPolicy.deploymentMode === "authenticated") {
    for (const name of DEFAULT_INHERITED_ENV_VARS) {
      if (!environmentNames.has(name)) env[name] = "";
    }
  }
  return { ...target, env };
}

export async function createManagedMcpClient(
  options: ManagedMcpClientOptions,
): Promise<ManagedMcpClient> {
  const sdkClient = new Client(
    { name: "rudder-managed-mcp", version: "1.0.0" },
    { versionNegotiation: { mode: "legacy" } },
  );
  const maxOutputBytes = options.maxOutputBytes ?? 10 * 1024 * 1024;
  let stderrBytes = 0;
  let transport: StreamableHTTPClientTransport | StdioClientTransport;
  let stdioTransport: StdioClientTransport | null = null;
  let stdioProcessId: number | null = null;
  let stdioOutputBoundaryExceeded = false;

  if (options.transport === "streamable_http") {
    assertSafeMcpHeaders(options.staticHeaders ?? {});
    assertSafeMcpCredentialHeaders(options.credentials.headers);
    const credentialAuthorization = Object.keys(options.credentials.headers)
      .some((name) => name.toLowerCase() === "authorization");
    if (credentialAuthorization && options.credentials.authProvider) {
      throw new ManagedMcpClientError(
        "mcp_conflicting_authorization",
        "Configure exactly one managed MCP Authorization source",
      );
    }
    transport = new StreamableHTTPClientTransport(new URL(options.url), {
      authProvider: options.credentials.authProvider,
      requestInit: {
        headers: {
          ...(options.staticHeaders ?? {}),
          ...options.credentials.headers,
        },
      },
      fetch: createSecureMcpFetch({
        ...options.network,
        maxResponseBytes: maxOutputBytes,
      }),
      onInsufficientScope: "throw",
    });
  } else {
    const launch = await prepareStdioLaunch(options);
    stdioTransport = new StdioClientTransport({
      command: launch.command,
      args: options.args,
      cwd: launch.cwd,
      env: launch.env,
      stderr: "pipe",
      maxBufferSize: maxOutputBytes,
    });
    transport = stdioTransport;
    stdioTransport.stderr?.on("data", (chunk: Buffer | string) => {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > maxOutputBytes) {
        stdioOutputBoundaryExceeded = true;
        const pid = stdioTransport?.pid;
        if (pid !== null && pid !== undefined) signalProcess(pid, "SIGKILL");
      }
    });
  }

  try {
    await sdkClient.connect(transport, { timeout: options.startupTimeoutMs });
  } catch (error) {
    if (stdioTransport) {
      await closeManagedStdioTransport(stdioTransport, stdioTransport.pid);
    } else {
      await transport.close().catch(() => undefined);
    }
    throw safeClientError(error, "connect");
  }
  if (stdioTransport) {
    stdioProcessId = stdioTransport.pid;
    const clientErrorHandler = stdioTransport.onerror;
    stdioTransport.onerror = (error) => {
      if (isStdioOutputBoundaryError(error)) {
        stdioOutputBoundaryExceeded = true;
        const pid = stdioTransport?.pid ?? stdioProcessId;
        if (pid !== null) signalProcess(pid, "SIGKILL");
      }
      clientErrorHandler?.(error);
    };
  }

  let closed = false;
  return {
    async discoverTools() {
      try {
        const result = await sdkClient.listTools(
          undefined,
          { timeout: options.startupTimeoutMs, cacheMode: "refresh" },
        );
        return result.tools;
      } catch (error) {
        throw safeClientError(error, "discover");
      }
    },
    async callTool(name, args) {
      try {
        const result = await sdkClient.callTool(
          { name, arguments: args },
          { timeout: options.toolTimeoutMs },
        );
        return boundedResult(result, maxOutputBytes);
      } catch (error) {
        if (stdioOutputBoundaryExceeded) {
          throw new ManagedMcpClientError(
            "mcp_result_too_large",
            "Managed MCP tool result exceeds the output limit",
          );
        }
        throw safeClientError(error, "call");
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      if (stdioTransport) {
        await closeManagedStdioTransport(stdioTransport, stdioProcessId);
      } else {
        await sdkClient.close();
      }
    },
  };
}
