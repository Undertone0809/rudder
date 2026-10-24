import { resolve } from "node:path";
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
  browserSessionAuth?: RustBrowserSessionAuth;
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
};

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
