import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { NativeProcessAuthority } from "@rudderhq/agent-runtime-utils";
import { createNativeProcessAuthority } from "../../agent-runtimes/utils.js";

/**
 * Authority issuance is intentionally opt-in. The normal runtime kernel can
 * propagate an issued envelope, but this private seam does not enable a public
 * native-process cutover by itself.
 */
export const NATIVE_PROCESS_AUTHORITY_ISSUANCE_ENV = "RUDDER_NATIVE_PROCESS_AUTHORITY_ISSUANCE";

export type NativeProcessAuthorityRun = {
  id: string;
  orgId: string;
  agentId: string;
  executionOwnerToken: string | null;
  executionLeaseExpiresAt: Date | null;
};

function nativeRuntimeRoot(env: NodeJS.ProcessEnv): string {
  const configured = env.RUDDER_NATIVE_PROCESS_RUNTIME_ROOT?.trim();
  if (configured) return path.resolve(configured);
  const base = env.RUDDER_HOME?.trim()
    ? path.resolve(env.RUDDER_HOME)
    : path.join(os.tmpdir(), `rudder-${typeof process.getuid === "function" ? process.getuid() : "user"}`);
  return path.join(base, "native", "process-runs");
}

export function nativeProcessAuthorityIssuanceEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[NATIVE_PROCESS_AUTHORITY_ISSUANCE_ENV] === "1";
}

export function issueNativeProcessAuthorityForAttempt(input: {
  run: NativeProcessAuthorityRun;
  attemptIndex: number;
  nowMillis?: number;
  env?: NodeJS.ProcessEnv;
}): NativeProcessAuthority | undefined {
  const { run } = input;
  const env = input.env ?? process.env;
  if (!nativeProcessAuthorityIssuanceEnabled(env) || !run.executionOwnerToken) return undefined;

  const nowMillis = input.nowMillis ?? Date.now();
  const expiresAtMillis = run.executionLeaseExpiresAt?.getTime() ?? 0;
  if (!Number.isSafeInteger(expiresAtMillis) || expiresAtMillis <= nowMillis) return undefined;

  const attemptNumber = input.attemptIndex + 1;
  if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1 || attemptNumber > 1_000_000) return undefined;

  const ownerToken = randomUUID();
  const requestId = randomUUID();
  return createNativeProcessAuthority({
    authorityVersion: 1,
    runtimeIdentity: {
      organizationId: run.orgId,
      agentId: run.agentId,
      runId: run.id,
    },
    ownership: {
      epoch: attemptNumber,
      fence: run.executionOwnerToken,
    },
    lease: {
      owner: run.executionOwnerToken,
      issuedAtMillis: nowMillis,
      expiresAtMillis,
    },
    attempt: attemptNumber,
    requestId,
    receiptContext: {
      runtimeRoot: nativeRuntimeRoot(env),
      ownerToken,
    },
  });
}
