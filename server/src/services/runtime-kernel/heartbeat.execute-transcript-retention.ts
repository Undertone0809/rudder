import type { TranscriptEntry } from "@rudderhq/agent-runtime-utils";
import type { Db } from "@rudderhq/db";
import {
  createProfileBoundRuntimeProviderCapabilityResolverFromConfig,
  type RuntimeProviderProfileConfig,
} from "../../agent-runtimes/index.js";
import { logger } from "../../middleware/logger.js";
import { createCursorTranscriptSupplementCapture } from "./cursor-transcript-supplement.js";
import {
  boundNativeHeartbeatTranscriptMemory,
  resolveHeartbeatTranscriptRetention,
  type HeartbeatTranscriptBindingContinuity,
  type HeartbeatTranscriptRetentionMode,
  type HeartbeatTranscriptRetentionPolicy,
} from "./heartbeat-transcript-retention.js";
import { createHeartbeatRuntimeDriver } from "./heartbeat.admission.js";
import {
  appendTranscriptEntriesFromChunk,
  createHeartbeatTranscriptFinalizer,
  type TranscriptChunkBuffer,
} from "./heartbeat.core.js";
import {
  normalizeRuntimeProviderCapabilityResolution,
  type RuntimeProviderBindingRef,
} from "./provider-capabilities.js";
import type { RuntimeDriverFactoryOptions } from "./runtime-driver.js";
import type { UnifiedAgentRunAdapter } from "./unified-agent-run.contracts.js";

type HeartbeatExecutionNativeBinding = Pick<
  RuntimeProviderBindingRef,
  "id" | "orgId" | "hostId" | "profileId" | "workspaceBindingId" | "capabilityRevision"
> & { continuity?: HeartbeatTranscriptBindingContinuity | null };

type NativeTranscriptSupplementOwner = {
  orgId: string;
  runId: string;
  spanId: string;
  ownerToken: string;
  attemptEpoch: number;
};

export function createHeartbeatExecutionTranscriptAppender(input: {
  transcript: TranscriptEntry[];
  stdoutBuffer: TranscriptChunkBuffer;
  stderrBuffer: TranscriptChunkBuffer;
  stdoutParser: () => ((line: string, ts: string) => TranscriptEntry[]) | null;
  persistRawTranscript: () => boolean;
  supplement: {
    append: (entries: readonly TranscriptEntry[]) => Promise<void>;
    finalize: (transcript: TranscriptEntry[], finalizeTranscript: () => Promise<void>) => Promise<void>;
  };
}) {
  const finalizeTranscript = createHeartbeatTranscriptFinalizer({
    transcript: input.transcript,
    stdoutBuffer: input.stdoutBuffer,
    stderrBuffer: input.stderrBuffer,
    stdoutParser: input.stdoutParser,
  });

  return {
    async appendChunk(kind: "stdout" | "stderr", chunk: string) {
      const transcriptStart = input.transcript.length;
      appendTranscriptEntriesFromChunk({
        buffer: kind === "stdout" ? input.stdoutBuffer : input.stderrBuffer,
        chunk,
        transcript: input.transcript,
        ...(kind === "stdout" ? { parser: input.stdoutParser() } : {}),
        kind,
      });
      await input.supplement.append(input.transcript.slice(transcriptStart));
      if (!input.persistRawTranscript()) boundNativeHeartbeatTranscriptMemory(input.transcript);
    },
    finalize: () => input.supplement.finalize(input.transcript, finalizeTranscript),
  };
}

export async function resolveHeartbeatExecutionTranscriptRetention(input: {
  db: Db;
  runId: string;
  runtimeType: string;
  runtimeConfig: RuntimeProviderProfileConfig["runtimeConfig"];
  cwd: string;
  adapter: RuntimeDriverFactoryOptions["adapter"];
  unifiedRunAdapter: UnifiedAgentRunAdapter | null | undefined;
  binding: HeartbeatExecutionNativeBinding;
}): Promise<HeartbeatTranscriptRetentionPolicy> {
  let profileCapability: Parameters<typeof resolveHeartbeatTranscriptRetention>[0]["profileCapability"] = null;
  let capabilityStatus: "supported" | "unsupported" | "unknown" = "unknown";
  try {
    const providerBinding = {
      id: input.binding.id,
      orgId: input.binding.orgId,
      hostId: input.binding.hostId,
      profileId: input.binding.profileId,
      workspaceBindingId: input.binding.workspaceBindingId,
      capabilityRevision: input.binding.capabilityRevision,
    };
    const providerCapabilityResolver = createProfileBoundRuntimeProviderCapabilityResolverFromConfig({
      runtimeType: input.runtimeType,
      runtimeConfig: input.runtimeConfig,
      cwd: input.cwd,
      resolutionMode: "live",
    });
    const driver = createHeartbeatRuntimeDriver(
      { db: input.db, unifiedRunAdapter: input.unifiedRunAdapter },
      input.runtimeType,
      { adapter: input.adapter, providerCapabilityResolver, providerBinding },
    );
    capabilityStatus = driver?.capabilities.transcriptRange.status ?? "unknown";
    profileCapability = {
      runtimeType: input.runtimeType,
      binding: providerBinding,
      driverStatus: capabilityStatus,
      resolution: normalizeRuntimeProviderCapabilityResolution(
        providerCapabilityResolver(input.runtimeType, providerBinding),
        input.runtimeType,
        providerBinding,
      ),
    };
  } catch (error) {
    logger.warn({ err: error, runId: input.runId }, "native transcript retention capability could not be resolved");
  }

  return resolveHeartbeatTranscriptRetention({
    hasBinding: true,
    bindingContinuity: input.binding.continuity,
    capabilityStatus,
    profileCapability,
  });
}

export function createHeartbeatExecutionTranscriptSupplement(input: {
  db: Db;
  runId: string;
  retentionMode: () => HeartbeatTranscriptRetentionMode;
  owner: () => NativeTranscriptSupplementOwner | null;
}) {
  let failure: string | null = null;
  const capture = createCursorTranscriptSupplementCapture(input.db, undefined, () => {
    failure = "native_supplement_seal_failed";
    logger.warn({ runId: input.runId }, "native transcript supplement could not be sealed");
  });

  async function append(entries: readonly TranscriptEntry[]) {
    if (entries.length === 0 || input.retentionMode() !== "native") return;
    const owner = input.owner();
    if (!owner) {
      failure ??= "native_supplement_run_span_owner_missing";
      return;
    }
    try {
      await capture.append(owner, entries);
    } catch {
      failure ??= "native_supplement_append_failed";
      logger.warn({ runId: input.runId }, "native transcript supplement append failed");
    }
  }

  return {
    get failure() {
      return failure;
    },
    append,
    async finalize(transcript: TranscriptEntry[], finalizeTranscript: () => Promise<void>) {
      const start = transcript.length;
      await finalizeTranscript();
      await append(transcript.slice(start));
      if (input.retentionMode() === "native") await capture.seal();
    },
  };
}
