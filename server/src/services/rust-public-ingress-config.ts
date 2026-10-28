import { homedir, hostname, userInfo } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LocalAccountAuthOptions } from "../bootstrap/auth-runtime.js";

export type RustBrowserSessionAuth = Readonly<{
  issuer: "local_account";
  secret: string;
  secureCookie: boolean;
} | {
  issuer: "better_auth";
  secret: string;
  secureCookie: boolean;
  sessionCookieName: string;
  dontRememberCookieName: string;
  expiresIn: number;
  updateAge: number;
  disableSessionRefresh: boolean;
  /** Effective Better Auth trust list used by native email lifecycle CSRF checks. */
  trustedOrigins: readonly string[];
  /** Constructed Better Auth sign-up policy; configuration transport only. */
  disableSignUp: boolean;
  /** Constructed Better Auth request rate-limit enablement; transport only. */
  rateLimitEnabled: boolean;
}>;

export type RustLocalAccountLifecycleOptions = {
  installationId: string;
  expectedIssuer: string;
  audience: string;
  identityOrigin: string;
  offline?: LocalAccountAuthOptions["offline"];
};

export type RustNativeSessionAuthOptions = {
  kind: "better_auth" | "local_account";
  secret: string;
  secureCookie: boolean;
  assertionKey: string;
  /** Effective private WebSocket credential fallback; required for local-account sessions. */
  websocketCookieFallback?: "session" | "local_implicit";
};

export type RustNativeIdentityAuthOptions = {
  /** One-use private-hop proof key, shared with the existing session assertion path. */
  assertionKey: string;
  /** Resolved from the legacy Agent JWT secret selection, not a new signing secret. */
  agentJwtSecret: string;
  agentJwtIssuer: string;
  agentJwtAudience: string;
  localImplicitEnabled: boolean;
};

/** Installation facts only. Rust resolves Agents, Profiles and execution policy. */
export type RustNativeChatHost = Readonly<{
  instanceId: string;
  instanceRoot: string;
  workspaceHome: string;
  operatorHome: string;
  codexHome?: string;
  /** Optional Rust-discovered local provider installation facts. */
  piNodeExecutable?: string;
  piCliEntry?: string;
  claudeExecutable?: string;
  cursorExecutable?: string;
  /** Explicitly owned OpenCode Server endpoint; never request supplied. */
  opencodeServerUrl?: string;
  opencodeBearerToken?: string;
  executableSearchPath: string;
  friendlyWorkspaceHome: boolean;
  deploymentMode: string;
  deploymentExposure: string;
  authRequirement: string;
  trustedOrigins: readonly string[];
}>;

export type RustIssueAssetStorage =
  | {
      provider: "local_disk";
      localDiskBaseDir: string;
    }
  | {
      provider: "s3";
      bucket: string;
      region: string;
      endpoint?: string;
      prefix: string;
      forcePathStyle: boolean;
    };

/** Resolve optional provider installation facts from trusted process configuration. */
export function resolveNativeChatProviderHostFields(): Readonly<Record<string, string>> {
  return {
    ...(process.env.RUDDER_PI_NODE_EXECUTABLE?.trim()
      ? { piNodeExecutable: resolve(process.env.RUDDER_PI_NODE_EXECUTABLE.trim()) }
      : {}),
    ...(process.env.RUDDER_PI_CLI_ENTRY?.trim()
      ? { piCliEntry: resolve(process.env.RUDDER_PI_CLI_ENTRY.trim()) }
      : {}),
    ...(process.env.RUDDER_CLAUDE_EXECUTABLE?.trim()
      ? { claudeExecutable: resolve(process.env.RUDDER_CLAUDE_EXECUTABLE.trim()) }
      : {}),
    ...(process.env.RUDDER_CURSOR_EXECUTABLE?.trim()
      ? { cursorExecutable: resolve(process.env.RUDDER_CURSOR_EXECUTABLE.trim()) }
      : {}),
    ...(process.env.RUDDER_OPENCODE_SERVER_URL?.trim()
      ? { opencodeServerUrl: process.env.RUDDER_OPENCODE_SERVER_URL.trim() }
      : {}),
    ...(process.env.RUDDER_OPENCODE_BEARER_TOKEN?.trim()
      ? { opencodeBearerToken: process.env.RUDDER_OPENCODE_BEARER_TOKEN.trim() }
      : {}),
  };
}

export type RustPublicIngressOptions = {
  /** Existing configured cadence; Rust owns scheduled producers. */
  scheduler?: { enabled: boolean; intervalMs: number };
  browserSessionAuth?: RustBrowserSessionAuth;
  /** Trusted launcher facts consumed by Rust execution and OAuth policy. */
  publicApiUrl?: string;
  authPublicBaseUrl?: string;
  nativeChatHost?: RustNativeChatHost;
  listenAddr: string;
  nodeUpstream: string;
  authorizationKey: string;
  /** Runtime mode used by Rust-owned Agent capability projection. */
  deploymentMode?: "local_trusted" | "authenticated";
  /** Effective Express private-host gate, copied to direct Rust public handlers. */
  privateHostGate?: {
    enabled: boolean;
    allowedHostnames: string[];
    bindHost: string;
  };
  /** Explicit numeric proxy IP list; Rust validates and owns forwarding trust. */
  trustedProxies?: string;
  /** Existing session-cookie authority and distinct private-hop assertion key. */
  sessionAuth?: RustNativeSessionAuthOptions;
  localAccountLifecycle?: RustLocalAccountLifecycleOptions;
  /** Native public identity authority for sessions, API keys, Agent JWTs and local implicit. */
  identityAuth?: RustNativeIdentityAuthOptions;
  /** Object I/O configuration for Rust-owned Issue description attachment writes. */
  issueAssetStorage?: RustIssueAssetStorage;
};

const AWS_ISSUE_STORAGE_ENVIRONMENT_KEYS = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "AWS_DEFAULT_PROFILE",
  "AWS_SDK_LOAD_CONFIG",
  "AWS_CONFIG_FILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_ROLE_ARN",
  "AWS_ROLE_SESSION_NAME",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
  "AWS_EC2_METADATA_DISABLED",
  "AWS_EC2_METADATA_V1_DISABLED",
  "AWS_EC2_METADATA_SERVICE_ENDPOINT",
  "AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE",
  "AWS_ENDPOINT_URL",
  "AWS_ENDPOINT_URL_S3",
  "AWS_CA_BUNDLE",
  "AWS_RETRY_MODE",
  "AWS_MAX_ATTEMPTS",
  "PATH",
] as const;

export function nativeIssueAssetStorageEnvironment(
  storage?: RustIssueAssetStorage,
): Record<string, string> {
  if (!storage) return {};
  const environment: Record<string, string> = {
    RUDDER_NATIVE_ISSUE_ASSET_STORAGE_CONFIG: JSON.stringify(storage),
  };
  if (storage.provider !== "s3") return environment;

  // Forward only the AWS SDK's configured credential/profile settings when S3
  // is selected. Keep credentials out of the JSON config payload and logs.
  environment.HOME = process.env.HOME?.trim() || homedir();
  if (process.platform === "win32") {
    environment.USERPROFILE = process.env.USERPROFILE?.trim() || homedir();
  }
  for (const key of AWS_ISSUE_STORAGE_ENVIRONMENT_KEYS) {
    const value = process.env[key];
    if (value !== undefined && value !== "") environment[key] = value;
  }
  return environment;
}

export function nativeSessionAuthEnvironment(
  sessionAuth?: RustNativeSessionAuthOptions,
): Record<string, string> {
  if (!sessionAuth) return {};
  if (sessionAuth.kind === "local_account" && !sessionAuth.websocketCookieFallback) {
    throw new Error("Local-account Rust ingress requires an explicit WebSocket cookie fallback");
  }
  return {
    RUDDER_NATIVE_SESSION_AUTH_MODE: "required",
    RUDDER_NATIVE_SESSION_AUTH_KIND: sessionAuth.kind,
    RUDDER_NATIVE_SESSION_AUTH_SECRET: sessionAuth.secret,
    RUDDER_NATIVE_SESSION_COOKIE_SECURE: String(sessionAuth.secureCookie),
    RUDDER_NATIVE_SESSION_ASSERTION_KEY: sessionAuth.assertionKey,
    ...(sessionAuth.websocketCookieFallback
      ? { RUDDER_NATIVE_WEBSOCKET_COOKIE_FALLBACK: sessionAuth.websocketCookieFallback }
      : {}),
  };
}

export function nativeIdentityAuthEnvironment(
  identityAuth?: RustNativeIdentityAuthOptions,
): Record<string, string> {
  if (!identityAuth) return {};
  return {
    RUDDER_NATIVE_IDENTITY_AUTH_MODE: "required",
    RUDDER_NATIVE_IDENTITY_ASSERTION_KEY: identityAuth.assertionKey,
    RUDDER_NATIVE_AGENT_JWT_SECRET: identityAuth.agentJwtSecret,
    RUDDER_NATIVE_AGENT_JWT_ISSUER: identityAuth.agentJwtIssuer,
    RUDDER_NATIVE_AGENT_JWT_AUDIENCE: identityAuth.agentJwtAudience,
    RUDDER_NATIVE_LOCAL_IMPLICIT: String(identityAuth.localImplicitEnabled),
  };
}

export function nativeLocalAccountLifecycleEnvironment(
  options: RustPublicIngressOptions,
): Record<string, string> {
  if (!options.localAccountLifecycle) return {};
  if (options.sessionAuth?.kind !== "local_account") {
    throw new Error("Native local-account lifecycle requires local-account session authentication");
  }
  return {
    RUDDER_NATIVE_LOCAL_ACCOUNT_AUTH_CONFIG: JSON.stringify(options.localAccountLifecycle),
  };
}

export function createFoundationChildEnvironment(input: {
  databaseUrl: string;
  actorEnvelopeKey: string;
  publicIngress?: RustPublicIngressOptions;
  secretsMasterKey?: string;
  secretsMasterKeyFile: string;
}): Record<string, string> {
  let hostUsername: string | undefined;
  try { hostUsername = userInfo().username; } catch { /* Match unavailable host metadata. */ }
  return {
    // ZIP DOS timestamps follow the Node host's local Date semantics. Keep
    // this explicit non-secret locale setting without inheriting other env.
    ...(process.env.TZ ? { TZ: process.env.TZ } : {}),
    RUDDER_NATIVE_LISTEN: "127.0.0.1:0",
    RUDDER_NATIVE_DATABASE_URL: input.databaseUrl,
    RUDDER_NATIVE_DATABASE_REQUIRED: "true",
    RUDDER_NATIVE_ACTOR_ENVELOPE_KEY: input.actorEnvelopeKey,
    // These existing feature gates must reach the native authority as well as
    // the public transport. Do not inherit the rest of the ambient environment.
    ...Object.fromEntries([
      "RUDDER_AGENT_CREATE_RUST_ENABLED",
      "RUDDER_AGENT_CREATE_INSTRUCTIONS_DURABLE_ENABLED",
      "RUDDER_AGENT_CREATE_RUST_MANAGED_MCP_ENABLED",
      "RUDDER_AGENT_CREATE_INTELLIGENCE_AVATAR_RUST_ENABLED",
    ].flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]])),
    // Transport only the existing log-store paths and host masking facts.
    // All file reads and masking decisions remain native.
    ...Object.fromEntries([
      "USER", "LOGNAME", "USERNAME", "HOME", "USERPROFILE",
    ].flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]])),
    ...(process.env.RUN_LOG_BASE_PATH !== undefined
      ? { RUN_LOG_BASE_PATH: resolve(process.env.RUN_LOG_BASE_PATH) } : {}),
    ...(process.env.WORKSPACE_OPERATION_LOG_BASE_PATH !== undefined
      ? { WORKSPACE_OPERATION_LOG_BASE_PATH: resolve(process.env.WORKSPACE_OPERATION_LOG_BASE_PATH) } : {}),
    ...(hostUsername ? { RUDDER_NATIVE_HOST_USERNAME: hostUsername } : {}),
    RUDDER_NATIVE_HOST_LOCALE: new Intl.Collator().resolvedOptions().locale,
    ...(process.env.PATH !== undefined ? { PATH: process.env.PATH } : {}),
    ...(process.env.RUDDER_API_URL !== undefined
      ? { RUDDER_NATIVE_HOST_API_URL: process.env.RUDDER_API_URL }
      : {}),
    RUDDER_NATIVE_HOST_HOME_DIRECTORY: homedir(),
    RUDDER_NATIVE_HOST_PROCESS_WORKING_DIRECTORY: process.cwd(),
    RUDDER_NATIVE_HOST_HOSTNAME: hostname(),
    // Existing generic Agent runtimes inherit operator variables. Transport the
    // raw facts separately; Rust selects/filters child environments. Activate
    // execution only when the launcher also supplied its installation facts.
    // Chat's narrower LocalHostContext environment contract is unchanged.
    ...(input.publicIngress?.identityAuth ? {
      ...(input.publicIngress.nativeChatHost ? {
        RUDDER_NATIVE_HOST_BUNDLED_SKILL_ROOTS: JSON.stringify([
          resolve(dirname(fileURLToPath(import.meta.url)), "../../resources/bundled-skills"),
          resolve(process.cwd(), "server/resources/bundled-skills"),
        ]),
        RUDDER_NATIVE_HOST_RUNTIME_ENVIRONMENT: JSON.stringify(Object.fromEntries(
          Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
        )),
      } : {}),
      ...(input.publicIngress.publicApiUrl ? {
        RUDDER_NATIVE_HOST_API_URL: input.publicIngress.publicApiUrl,
      } : {}),
      ...(input.publicIngress.authPublicBaseUrl ? {
        RUDDER_NATIVE_HOST_AUTH_PUBLIC_BASE_URL: input.publicIngress.authPublicBaseUrl,
      } : {}),
    } : {}),
    ...(process.env.RUDDER_HOME !== undefined
      ? { RUDDER_NATIVE_HOST_RUDDER_HOME: process.env.RUDDER_HOME }
      : {}),
    ...(process.env.RUDDER_INSTANCE_ID !== undefined
      ? { RUDDER_NATIVE_HOST_INSTANCE_ID: process.env.RUDDER_INSTANCE_ID }
      : {}),
    ...(process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME !== undefined
      ? { RUDDER_NATIVE_HOST_ORGANIZATION_WORKSPACE_HOME: process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME }
      : {}),
    ...(input.secretsMasterKey ? { RUDDER_SECRETS_MASTER_KEY: input.secretsMasterKey } : {}),
    RUDDER_SECRETS_MASTER_KEY_FILE: input.secretsMasterKeyFile,
    ...(process.env.RUDDER_SECRETS_PROVIDER !== undefined
      ? { RUDDER_SECRETS_PROVIDER: process.env.RUDDER_SECRETS_PROVIDER }
      : {}),
    ...(input.publicIngress ? {
      RUDDER_NATIVE_PUBLIC_LISTEN: input.publicIngress.listenAddr,
      RUDDER_NATIVE_NODE_UPSTREAM: input.publicIngress.nodeUpstream,
      RUDDER_NATIVE_INGRESS_AUTH_KEY: input.publicIngress.authorizationKey,
      ...(input.publicIngress.scheduler ? { RUDDER_NATIVE_SCHEDULER: JSON.stringify(input.publicIngress.scheduler) } : {}),
      RUDDER_NATIVE_DEPLOYMENT_MODE: input.publicIngress.deploymentMode ?? "authenticated",
      ...(input.publicIngress.privateHostGate
        ? { RUDDER_NATIVE_PRIVATE_HOST_GATE: JSON.stringify(input.publicIngress.privateHostGate) }
        : {}),
      ...nativeIdentityAuthEnvironment(input.publicIngress.identityAuth),
      ...nativeIssueAssetStorageEnvironment(input.publicIngress.issueAssetStorage),
      ...nativeSessionAuthEnvironment(input.publicIngress.sessionAuth),
      ...nativeLocalAccountLifecycleEnvironment(input.publicIngress),
      ...(input.publicIngress.nativeChatHost
        ? {
            RUDDER_NATIVE_CHAT_HOST: JSON.stringify(input.publicIngress.nativeChatHost),
            PATH: input.publicIngress.nativeChatHost.executableSearchPath,
          }
        : {}),
      ...(input.publicIngress.browserSessionAuth
        ? { RUDDER_NATIVE_BROWSER_AUTH_ISSUER: JSON.stringify(input.publicIngress.browserSessionAuth) }
        : {}),
      ...(input.publicIngress.trustedProxies ? { RUDDER_NATIVE_INGRESS_TRUSTED_PROXIES: input.publicIngress.trustedProxies } : {}),
    } : {}),
  };
}
