import { assertPersistablePiRpcArgs } from "@rudderhq/agent-runtime-utils/server-utils";
import type { Db } from "@rudderhq/db";
import { heartbeatRunAttempts, heartbeatRuns, runRuntimeSpans } from "@rudderhq/db";
import { and, desc, eq, sql } from "drizzle-orm";
import path from "node:path";

export function filterNativeTransportProfile(profile: Record<string, unknown>): Record<string, unknown> {
  const runtimeType = profile.runtimeType;
  if (runtimeType !== "pi_local" && runtimeType !== "opencode_local") {
    throw new Error("Unsupported dynamic native transport profile");
  }
  const result: Record<string, unknown> = { runtimeType };
  const stringKeys = runtimeType === "pi_local"
    ? ["command", "cwd", "sessionDir", "providerVersion"]
    : ["command", "cwd", "serverCommand", "exportCommand", "providerVersion"];
  for (const key of stringKeys) {
    if (typeof profile[key] === "string" && profile[key].trim()) result[key] = profile[key];
  }
  if (runtimeType === "pi_local" && Array.isArray(profile.rpcArgs)
    && profile.rpcArgs.every((arg) => typeof arg === "string")) {
    assertPersistablePiRpcArgs(profile.rpcArgs);
    result.rpcArgs = [...profile.rpcArgs];
  }
  if (runtimeType === "opencode_local" && typeof profile.serverUrl === "string") {
    const url = new URL(profile.serverUrl);
    if (!["http:", "https:"].includes(url.protocol)
      || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      || url.username || url.password || url.search || url.hash) {
      throw new Error("Native transport server URL must be an unauthenticated loopback address");
    }
    result.serverUrl = url.toString();
  }
  const envKey = runtimeType === "pi_local" ? "rpcEnv" : "exportEnv";
  const env = profile[envKey];
  const allowed = new Set(runtimeType === "pi_local"
    ? ["HOME", "USERPROFILE", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "PI_OFFLINE"]
    : ["HOME", "USERPROFILE", "RUDDER_OPERATOR_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
      "OPENCODE_DISABLE_CLAUDE_CODE", "OPENCODE_DISABLE_CLAUDE_CODE_PROMPT", "OPENCODE_DISABLE_CLAUDE_CODE_SKILLS"]);
  if (env && typeof env === "object" && !Array.isArray(env)) {
    result[envKey] = Object.fromEntries(Object.entries(env).filter(([key, value]) => allowed.has(key) && typeof value === "string"));
  }
  return result;
}

/** Persist only a server-filtered transport projection. Provider/session data
 * must not enter this function as execution authority. */
export async function persistNativeTransportProfile(db: Db, input: {
  orgId: string;
  runId: string;
  spanId: string;
  ownerToken: string;
  attemptEpoch: number;
  attemptId: string;
  profile: Record<string, unknown>;
  nativeTranscriptAttested?: boolean;
}): Promise<void> {
  await db.transaction(async (tx) => {
    // Same admission lock as the common Run adapter; row locks also serialize
    // legacy terminal writers and native span completion.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.runId}))`);
    const [run] = await tx.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.orgId, input.orgId),
    )).for("update");
    if (!run || run.status !== "running" || run.executionOwnerToken !== input.ownerToken
      || !run.executionLeaseExpiresAt || run.executionLeaseExpiresAt.getTime() <= Date.now()) {
      throw new Error("Native transport profile rejected: stale Run owner");
    }
    const [span] = await tx.select().from(runRuntimeSpans).where(and(
      eq(runRuntimeSpans.runId, input.runId), eq(runRuntimeSpans.orgId, input.orgId),
    )).orderBy(desc(runRuntimeSpans.ordinal)).limit(1).for("update");
    const [attempt] = await tx.select().from(heartbeatRunAttempts).where(and(
      eq(heartbeatRunAttempts.runId, input.runId), eq(heartbeatRunAttempts.orgId, input.orgId),
    )).orderBy(desc(heartbeatRunAttempts.attemptIndex)).limit(1);
    if (!span || span.id !== input.spanId || span.state !== "open"
      || span.ownerToken !== input.ownerToken || span.attemptEpoch !== input.attemptEpoch
      || span.attemptId !== input.attemptId || attempt?.id !== input.attemptId
      || attempt.runtimeType !== input.profile.runtimeType) {
      throw new Error("Native transport profile rejected: stale runtime attempt");
    }
    const context = run.contextSnapshot ?? {};
    const previous = context.runtimeProviderProfile;
    const previousProfile = previous && typeof previous === "object" && !Array.isArray(previous)
      ? previous as Record<string, unknown> : {};
    const witnessedProfile = filterNativeTransportProfile(input.profile);
    const profile = {
      ...(previousProfile.runtimeType === input.profile.runtimeType ? previousProfile : {}),
      ...witnessedProfile,
    };
    if (input.nativeTranscriptAttested && input.profile.runtimeType !== "pi_local") {
      throw new Error("Only the witnessed Pi RPC transport can attest a fresh native transcript");
    }
    if (input.nativeTranscriptAttested && (
      previousProfile.runtimeType !== "pi_local"
      || typeof profile.providerVersion !== "string" || !profile.providerVersion.trim()
      || typeof profile.command !== "string" || !profile.command.trim()
      || typeof profile.cwd !== "string" || !path.isAbsolute(profile.cwd)
      || typeof profile.sessionDir !== "string" || !path.isAbsolute(profile.sessionDir)
      || !Array.isArray(profile.rpcArgs) || profile.rpcArgs.length === 0
      || !profile.rpcEnv || typeof profile.rpcEnv !== "object"
    )) {
      throw new Error("Pi native transcript attestation requires the complete Host RPC profile");
    }
    await tx.update(heartbeatRuns).set({ contextSnapshot: {
      ...context, runtimeProviderProfile: profile,
      ...(input.nativeTranscriptAttested ? { transcriptSource: "native" } : {}),
    } }).where(eq(heartbeatRuns.id, run.id));
  });
}
