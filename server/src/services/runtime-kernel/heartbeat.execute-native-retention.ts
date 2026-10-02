import type { AgentRuntimeExecutionResult } from "@rudderhq/agent-runtime-utils";
import type { Db } from "@rudderhq/db";
import type { AgentRuntimeInvocationMeta } from "../../agent-runtimes/index.js";
import { logger } from "../../middleware/logger.js";
import { summarizeHeartbeatRunResultJson } from "../heartbeat-run-summary.js";
import type { RunLogStore } from "../run-log-store.js";
import { retainNativeHeartbeatResultJson } from "./heartbeat-transcript-retention.js";
import { buildHeartbeatAdapterInvokePayload, readNonEmptyString } from "./heartbeat.core.js";
import { createHistoricalTranscriptReader } from "./historical-transcript-reader.js";
import {
  cleanSealedNativeTranscriptMirrors,
  markNativeTranscriptRetentionIncomplete,
  proveSealedNativeRunTranscript,
  type NativeTranscriptRunProof,
} from "./native-transcript-retention.js";
import { getTranscriptObjectStore } from "./transcript-object-store.js";
import { markLegacyTranscriptSource } from "./transcript-source.js";

export type NativeTranscriptRetentionOwner = {
  spanId: string;
  ownerToken: string;
  attemptEpoch: number;
  attemptId: string;
};

type TerminalRun = {
  id: string;
  orgId: string;
  status: string;
  executionOwnerToken: string | null;
  terminalEffectsPending: boolean;
};

export function captureNativeTranscriptRetentionOwner(input: {
  spanId: string | null;
  ownerToken: string | null;
  attemptEpoch: number;
  attemptId: string | null | undefined;
}): NativeTranscriptRetentionOwner | null {
  if (!input.spanId || !input.ownerToken || input.attemptId == null) return null;
  return {
    spanId: input.spanId,
    ownerToken: input.ownerToken,
    attemptEpoch: input.attemptEpoch,
    attemptId: input.attemptId,
  };
}

export function compactHeartbeatAdapterInvokePayload(payload: Record<string, unknown>) {
  const desiredSkills = Array.isArray(payload.desiredSkills) ? payload.desiredSkills : [];
  const runtimeSkills = desiredSkills.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const skill = value as Record<string, unknown>;
    const key = typeof skill.key === "string" && skill.key.trim() ? skill.key.trim() : null;
    if (!key) return [];
    return [{
      key,
      runtimeName: typeof skill.runtimeName === "string" && skill.runtimeName.trim() ? skill.runtimeName : key,
      name: typeof skill.name === "string" ? skill.name : null,
      description: typeof skill.description === "string" ? skill.description : null,
    }];
  });
  return buildHeartbeatAdapterInvokePayload({
    meta: payload as unknown as AgentRuntimeInvocationMeta,
    preservePersistedInstructionAlias: true,
    runtimeSkills,
    transcriptRetention: {
      mode: "native",
      persistRawTranscript: false,
      reason: "native_transcript_capability",
    },
  });
}

export function projectHeartbeatAdapterResult(input: {
  adapterResult: AgentRuntimeExecutionResult;
  persistRawResult: boolean;
  outcome: string;
  status: string;
  timestamp: string;
}) {
  const { adapterResult } = input;
  const persistedResultJson = input.persistRawResult
    ? markLegacyTranscriptSource(adapterResult.resultJson)
    : retainNativeHeartbeatResultJson(adapterResult.resultJson);
  const persistedAdapterResult = input.persistRawResult
    ? adapterResult
    : { ...adapterResult, resultJson: persistedResultJson };
  const adapterResultSummary = summarizeHeartbeatRunResultJson(adapterResult.resultJson);
  const persistedResultSummary = summarizeHeartbeatRunResultJson({
    ...(persistedResultJson ?? {}),
    ...(readNonEmptyString(adapterResult.summary) ? { summary: adapterResult.summary } : {}),
  });

  return {
    persistedResultJson,
    persistedAdapterResult,
    persistedResultSummary,
    transcriptFallbackResult: {
      ts: input.timestamp,
      model: readNonEmptyString(adapterResult.model),
      output:
        readNonEmptyString(adapterResult.summary)
        ?? readNonEmptyString(adapterResultSummary?.result)
        ?? readNonEmptyString(adapterResultSummary?.summary)
        ?? readNonEmptyString(adapterResultSummary?.message)
        ?? null,
      usage: adapterResult.usage ?? null,
      costUsd: typeof adapterResult.costUsd === "number" ? adapterResult.costUsd : null,
      subtype: input.status,
      isError: input.outcome !== "succeeded",
      errors: adapterResult.errorMessage ? [adapterResult.errorMessage] : [],
    },
  };
}

export async function finalizeHeartbeatNativeTranscriptRetention(input: {
  db: Db;
  getRun: (runId: string) => Promise<TerminalRun | null>;
  runId: string;
  runLogStore: RunLogStore;
  bindingContinuity: string | null | undefined;
  expectedOwner: NativeTranscriptRetentionOwner | null;
  supplementFailure?: string | null;
}): Promise<void> {
  const sealedRun = await input.getRun(input.runId).catch(() => null);
  if (!input.expectedOwner
    || input.bindingContinuity !== "native"
    || !sealedRun
    || !["succeeded", "failed", "cancelled", "timed_out"].includes(sealedRun.status)
    || sealedRun.executionOwnerToken !== null
    || sealedRun.terminalEffectsPending) return;

  const expectedOwner = input.expectedOwner;
  let proof: NativeTranscriptRunProof | null = null;
  try {
    if (sealedRun.status !== "succeeded") {
      await markNativeTranscriptRetentionIncomplete({
        db: input.db,
        orgId: sealedRun.orgId,
        runId: sealedRun.id,
        expectedOwner,
        reason: `run_terminal_${sealedRun.status}`,
      });
    } else {
      const readerFactory = (database: Pick<Db, "select">) =>
        createHistoricalTranscriptReader(database, { includeObjects: false });
      const proofResult = await proveSealedNativeRunTranscript({
        db: input.db,
        reader: readerFactory(input.db),
        orgId: sealedRun.orgId,
        runId: sealedRun.id,
        expectedOwner,
      });
      if (!proofResult.ok) {
        await markNativeTranscriptRetentionIncomplete({
          db: input.db,
          orgId: sealedRun.orgId,
          runId: sealedRun.id,
          expectedOwner,
          reason: input.supplementFailure
            ? `${proofResult.reason}; ${input.supplementFailure}`
            : proofResult.reason,
        });
      } else {
        proof = proofResult.proof;
        const cleanup = await cleanSealedNativeTranscriptMirrors({
          db: input.db,
          proof: proofResult.proof,
          runLogStore: input.runLogStore,
          transcriptObjectStore: getTranscriptObjectStore(),
          readerFactory,
          retainResultJson: retainNativeHeartbeatResultJson,
          compactAdapterInvokePayload: compactHeartbeatAdapterInvokePayload,
        });
        if (!cleanup.cleaned) {
          await markNativeTranscriptRetentionIncomplete({
            db: input.db,
            orgId: sealedRun.orgId,
            runId: sealedRun.id,
            expectedOwner,
            status: "cleanup_failed",
            reason: cleanup.reason,
            recovery: cleanup.recovery,
            proof,
          });
        }
      }
    }
  } catch (error) {
    await markNativeTranscriptRetentionIncomplete({
      db: input.db,
      orgId: sealedRun.orgId,
      runId: sealedRun.id,
      expectedOwner,
      status: "cleanup_failed",
      reason: error instanceof Error ? error.message : "native_retention_failed",
      ...(proof ? { proof } : {}),
    }).catch(() => undefined);
    logger.warn({ err: error, runId: input.runId }, "native transcript mirror cleanup did not complete");
  }
}
