import type { Db } from "@rudderhq/db";
import { startSideChatCloseWorker } from "../services/side-chat-close.js";
import type { StorageService } from "../storage/types.js";

export function startSideChatCloseRuntime(input: {
  db: Db;
  storage: StorageService;
  logger?: { error?(details: Record<string, unknown>, message: string): void };
  supervisor: { own(name: string, dispose: () => void | Promise<void>): void };
}): void {
  const worker = startSideChatCloseWorker(input.db, input.storage, { logger: input.logger });
  input.supervisor.own("side-chat-close-worker", () => worker.stop());
}
