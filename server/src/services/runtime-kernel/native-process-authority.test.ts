import { describe, expect, it } from "vitest";
import {
  issueNativeProcessAuthorityForAttempt,
  nativeProcessAuthorityIssuanceEnabled,
  selectNativeProcessAuthority,
} from "./native-process-authority.js";

const run = {
  id: "run-1",
  orgId: "org-1",
  agentId: "agent-1",
  executionOwnerToken: "owner-1",
  executionLeaseExpiresAt: new Date(10_000),
};

describe("native process authority issuance seam", () => {
  it("is disabled unless the private opt-in is explicit", () => {
    expect(nativeProcessAuthorityIssuanceEnabled({})).toBe(false);
    expect(issueNativeProcessAuthorityForAttempt({
      run,
      attemptIndex: 0,
      nowMillis: 1_000,
      env: {},
    })).toBeUndefined();
  });

  it("issues a bound authority after the durable attempt owner exists", () => {
    const authority = issueNativeProcessAuthorityForAttempt({
      run,
      attemptIndex: 2,
      nowMillis: 1_000,
      env: {
        RUDDER_NATIVE_PROCESS_AUTHORITY_ISSUANCE: "1",
        RUDDER_NATIVE_PROCESS_RUNTIME_ROOT: "/tmp/rudder-test-receipts",
      },
    });

    expect(authority).toMatchObject({
      authorityVersion: 1,
      runtimeIdentity: { organizationId: "org-1", agentId: "agent-1", runId: "run-1" },
      ownership: { epoch: 3, fence: "owner-1" },
      lease: { owner: "owner-1", issuedAtMillis: 1_000, expiresAtMillis: 10_000 },
      attempt: 3,
      receiptContext: { runtimeRoot: "/tmp/rudder-test-receipts" },
    });
    expect(authority?.bindingDigest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("clears a prior process authority when the next attempt is not a process", () => {
    const authority = issueNativeProcessAuthorityForAttempt({
      run,
      attemptIndex: 0,
      nowMillis: 1_000,
      env: {
        RUDDER_NATIVE_PROCESS_AUTHORITY_ISSUANCE: "1",
      },
    });

    expect(selectNativeProcessAuthority("process", authority)).toBe(authority);
    expect(selectNativeProcessAuthority("claude_local", authority)).toBeUndefined();
    expect(selectNativeProcessAuthority("process", undefined)).toBeUndefined();
  });
});
