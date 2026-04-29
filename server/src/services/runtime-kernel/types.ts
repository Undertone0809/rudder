import type { Db } from "@rudderhq/db";
import type { getRunLogStore } from "../run-log-store.js";
import type { heartbeatService } from "./orchestrator.js";

export interface HeartbeatKernelDeps {
  db: Db;
  runLogStore: ReturnType<typeof getRunLogStore>;
  activeRunExecutions: Set<string>;
  getCurrentUserRedactionOptions: () => Promise<{ enabled: boolean }>;
}

export type HeartbeatOrchestrator = ReturnType<typeof heartbeatService>;
