import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalAgentJwt, verifyLocalAgentJwt } from "../agent-auth-jwt.js";

describe("agent local JWT", () => {
  const secretEnv = "RUDDER_AGENT_JWT_SECRET";
  const betterAuthSecretEnv = "BETTER_AUTH_SECRET";
  const ttlEnv = "RUDDER_AGENT_JWT_TTL_SECONDS";
  const issuerEnv = "RUDDER_AGENT_JWT_ISSUER";
  const audienceEnv = "RUDDER_AGENT_JWT_AUDIENCE";

  const originalEnv = {
    secret: process.env[secretEnv],
    betterAuthSecret: process.env[betterAuthSecretEnv],
    ttl: process.env[ttlEnv],
    issuer: process.env[issuerEnv],
    audience: process.env[audienceEnv],
  };

  beforeEach(() => {
    process.env[secretEnv] = "test-secret";
    delete process.env[betterAuthSecretEnv];
    process.env[ttlEnv] = "3600";
    delete process.env[issuerEnv];
    delete process.env[audienceEnv];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalEnv.secret === undefined) delete process.env[secretEnv];
    else process.env[secretEnv] = originalEnv.secret;
    if (originalEnv.betterAuthSecret === undefined) delete process.env[betterAuthSecretEnv];
    else process.env[betterAuthSecretEnv] = originalEnv.betterAuthSecret;
    if (originalEnv.ttl === undefined) delete process.env[ttlEnv];
    else process.env[ttlEnv] = originalEnv.ttl;
    if (originalEnv.issuer === undefined) delete process.env[issuerEnv];
    else process.env[issuerEnv] = originalEnv.issuer;
    if (originalEnv.audience === undefined) delete process.env[audienceEnv];
    else process.env[audienceEnv] = originalEnv.audience;
  });

  it("creates and verifies a token", () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const token = createLocalAgentJwt("agent-1", "organization-1", "claude_local", "run-1");
    expect(typeof token).toBe("string");

    const claims = verifyLocalAgentJwt(token!);
    expect(claims).toMatchObject({
      sub: "agent-1",
      org_id: "organization-1",
      adapter_type: "claude_local",
      run_id: "run-1",
      iss: "rudder",
      aud: "rudder-api",
    });
  });

  it("falls back to BETTER_AUTH_SECRET when the agent JWT secret is unset", () => {
    delete process.env[secretEnv];
    process.env[betterAuthSecretEnv] = "shared-auth-secret";
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const token = createLocalAgentJwt("agent-1", "organization-1", "claude_local", "run-1");

    expect(typeof token).toBe("string");
    expect(verifyLocalAgentJwt(token!)).toMatchObject({
      sub: "agent-1",
      org_id: "organization-1",
      run_id: "run-1",
    });
  });

  it("falls back to the local dev secret when no explicit secret is configured", () => {
    delete process.env[secretEnv];
    delete process.env[betterAuthSecretEnv];
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const token = createLocalAgentJwt("agent-1", "organization-1", "claude_local", "run-1");

    expect(typeof token).toBe("string");
    expect(verifyLocalAgentJwt(token!)).toMatchObject({
      sub: "agent-1",
      org_id: "organization-1",
      run_id: "run-1",
    });
  });

  it("rejects expired tokens", () => {
    process.env[ttlEnv] = "1";
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const token = createLocalAgentJwt("agent-1", "organization-1", "claude_local", "run-1");

    vi.setSystemTime(new Date("2026-01-01T00:00:05.000Z"));
    expect(verifyLocalAgentJwt(token!)).toBeNull();
  });

  it("rejects issuer/audience mismatch", () => {
    process.env[issuerEnv] = "custom-issuer";
    process.env[audienceEnv] = "custom-audience";
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const token = createLocalAgentJwt("agent-1", "organization-1", "codex_local", "run-1");

    process.env[issuerEnv] = "rudder";
    process.env[audienceEnv] = "rudder-api";
    expect(verifyLocalAgentJwt(token!)).toBeNull();
  });
});
