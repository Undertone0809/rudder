export type RustNativeSessionAuthOptions = {
  kind: "better_auth" | "local_account";
  secret: string;
  secureCookie: boolean;
  assertionKey: string;
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

export type RustPublicIngressOptions = {
  listenAddr: string;
  nodeUpstream: string;
  authorizationKey: string;
  /** Explicit numeric proxy IP list; Rust validates and owns forwarding trust. */
  trustedProxies?: string;
  /** Existing session-cookie authority and distinct private-hop assertion key. */
  sessionAuth?: RustNativeSessionAuthOptions;
  /** Native public identity authority for sessions, API keys, Agent JWTs and local implicit. */
  identityAuth?: RustNativeIdentityAuthOptions;
};

export function nativeSessionAuthEnvironment(
  sessionAuth?: RustNativeSessionAuthOptions,
): Record<string, string> {
  if (!sessionAuth) return {};
  return {
    RUDDER_NATIVE_SESSION_AUTH_MODE: "required",
    RUDDER_NATIVE_SESSION_AUTH_KIND: sessionAuth.kind,
    RUDDER_NATIVE_SESSION_AUTH_SECRET: sessionAuth.secret,
    RUDDER_NATIVE_SESSION_COOKIE_SECURE: String(sessionAuth.secureCookie),
    RUDDER_NATIVE_SESSION_ASSERTION_KEY: sessionAuth.assertionKey,
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
