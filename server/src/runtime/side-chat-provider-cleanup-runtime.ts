import type { Db } from "@rudderhq/db";
import {
  startSideChatProviderCleanupWorker,
  type SideChatProviderCleanupOptions,
} from "../services/side-chat-provider-cleanup.js";

export function startSideChatProviderCleanupRuntime(input: {
  db: Db;
  logger?: SideChatProviderCleanupOptions["logger"];
  supervisor: { own(name: string, dispose: () => void | Promise<void>): void };
}): void {
  const worker = startSideChatProviderCleanupWorker(input.db, { logger: input.logger });
  input.supervisor.own("side-chat-provider-cleanup-worker", () => worker.stop());
}
