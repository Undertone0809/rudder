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
  source: "stored_snapshot";
  completeness: "complete";
  agentInstructionStack: string;
  sha256: string;
  byteSize: number;
} | RecoveredRunDeveloperInstructions;
