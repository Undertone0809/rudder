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
        token: input.oauth.token,
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

async function buildStdioEnvironment(options: ManagedMcpStdioClientOptions): Promise<Record<string, string>> {
  const environmentNames = new Set([
    ...Object.keys(options.staticEnv),
    ...Object.keys(options.secretEnv),
    ...options.forwardedEnv,
  ]);
  await validateMcpStdioPolicy({
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
  return env;
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
    transport = new StdioClientTransport({
      command: options.command,
      args: options.args,
      cwd: options.cwd,
      env: await buildStdioEnvironment(options),
      stderr: "pipe",
      maxBufferSize: maxOutputBytes,
    });
    transport.stderr?.on("data", (chunk: Buffer | string) => {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > maxOutputBytes) {
        void transport.close();
      }
    });
  }

  try {
    await sdkClient.connect(transport, { timeout: options.startupTimeoutMs });
  } catch (error) {
    await transport.close().catch(() => undefined);
    throw safeClientError(error, "connect");
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
        throw safeClientError(error, "call");
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      await sdkClient.close();
    },
  };
}
