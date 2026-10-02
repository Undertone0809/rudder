export interface RecoveredRunDeveloperInstructions {
  source: "codex_native_rollout";
  completeness: "partial";
  snapshotStatus: "missing";
  developerInstructions: string;
  /** Digest and byte size of original source bytes, before display redaction. */
  sha256: string;
  byteSize: number;
  spanId: string;
  sessionId: string;
  turnId: string;
}

export type AgentRunInvocationInstructions = {
  source: "stored_snapshot" | "persisted_invocation_inline";
  completeness: "complete";
  agentInstructionStack: string;
  /** Exact debug input restored from the same verified source, when referenced. */
  prompt?: string;
  sha256: string;
  byteSize: number;
} | RecoveredRunDeveloperInstructions;
