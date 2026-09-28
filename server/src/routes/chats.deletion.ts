import {
  heartbeatRuns,
  runRuntimeSpans,
  type Db,
} from "@rudderhq/db";
import { and, eq, isNull } from "drizzle-orm";
import { conflict } from "../errors.js";
import { hasActiveChatGeneration } from "../services/chat-generation-locks.js";
import { isPostgresError } from "../services/postgres-errors.js";

const CHAT_DELETE_QUIESCENCE_TIMEOUT_MS = 5_000;
const CHAT_DELETE_QUIESCENCE_POLL_MS = 100;
const ACTIVE_NATIVE_WRITER_DELETE_CONSTRAINT = "run_runtime_spans_active_writer_delete_check";

export function isActiveNativeWriterDeleteConstraint(error: unknown) {
  return isPostgresError(error, "23514", ACTIVE_NATIVE_WRITER_DELETE_CONSTRAINT);
}

export async function hasActiveNativeChatWriter(db: Db, orgId: string, conversationId: string) {
  const [span] = await db
    .select({ id: runRuntimeSpans.id })
    .from(runRuntimeSpans)
    .innerJoin(heartbeatRuns, eq(runRuntimeSpans.runId, heartbeatRuns.id))
    .where(and(
      eq(runRuntimeSpans.orgId, orgId),
      eq(heartbeatRuns.orgId, orgId),
      eq(heartbeatRuns.chatConversationId, conversationId),
      isNull(runRuntimeSpans.writerLeaseReleasedAt),
    ))
    .limit(1);
  return Boolean(span);
}

type ChatDeletionQuiescenceInput = {
  db: Db;
  orgId: string;
  conversationId: string;
  getLatestActiveGeneration: (conversationId: string) => Promise<unknown>;
  waitForOtherOwners?: boolean;
};

async function readChatDeletionState(
  input: ChatDeletionQuiescenceInput,
  timeoutMs: number,
): Promise<"active" | "quiescent" | "unavailable"> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const query = Promise.resolve()
    .then(() => Promise.all([
      input.getLatestActiveGeneration(input.conversationId),
      hasActiveNativeChatWriter(input.db, input.orgId, input.conversationId),
    ]))
    .then(([activeGeneration, activeWriter]) => activeGeneration || activeWriter ? "active" : "quiescent")
    .catch(() => "unavailable" as const);
  const deadline = new Promise<"unavailable">((resolve) => {
    timeout = setTimeout(() => resolve("unavailable"), timeoutMs);
  });

  try {
    return await Promise.race([query, deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function waitForChatDeletionQuiescence(input: ChatDeletionQuiescenceInput) {
  const deadline = Date.now() + CHAT_DELETE_QUIESCENCE_TIMEOUT_MS;
  while (true) {
    if (!hasActiveChatGeneration(input.conversationId)) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return false;
      const state = await readChatDeletionState(input, remainingMs);
      if (state === "quiescent") return true;
      if (state === "unavailable" || input.waitForOtherOwners === false) return false;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(CHAT_DELETE_QUIESCENCE_POLL_MS, remainingMs)));
  }
}

export function chatWriterQuiescenceConflict() {
  return conflict("Chat generation has not quiesced; the conversation was not deleted", {
    code: "chat_writer_quiescence_pending",
  });
}
