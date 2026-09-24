import { useAgentRunTranscripts } from "./useAgentRunTranscripts";

export function useCommentThreadAgentRunTranscripts(
  runs: readonly { id: string; status: string }[],
) {
  return useAgentRunTranscripts(runs.map((run) => ({
    runId: run.id,
    active: run.status === "queued" || run.status === "running",
  })));
}
