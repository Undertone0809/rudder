export type RustNativeSessionAuthOptions = {
  kind: "better_auth" | "local_account";
  secret: string;
  secureCookie: boolean;
  assertionKey: string;
};

export type RustPublicIngressOptions = {
  listenAddr: string;
  nodeUpstream: string;
  authorizationKey: string;
  /** Explicit numeric proxy IP list; Rust validates and owns forwarding trust. */
  trustedProxies?: string;
  /** Existing session-cookie authority and distinct private-hop assertion key. */
  sessionAuth?: RustNativeSessionAuthOptions;
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
