import type { agents } from "@rudderhq/db";
import {
  AGENT_RUN_CONCURRENCY_DEFAULT,
  AGENT_RUN_CONCURRENCY_MAX,
  AGENT_RUN_CONCURRENCY_MIN,
} from "@rudderhq/shared";
import { asBoolean, asNumber, parseObject } from "../../agent-runtimes/utils.js";

export function normalizeMaxConcurrentRuns(value: unknown) {
  const parsed = Math.floor(asNumber(value, AGENT_RUN_CONCURRENCY_DEFAULT));
  if (!Number.isFinite(parsed)) return AGENT_RUN_CONCURRENCY_DEFAULT;
  return Math.max(AGENT_RUN_CONCURRENCY_MIN, Math.min(AGENT_RUN_CONCURRENCY_MAX, parsed));
}

export function parseHeartbeatPolicy(agent: typeof agents.$inferSelect) {
  const runtimeConfig = parseObject(agent.runtimeConfig);
  const heartbeat = parseObject(runtimeConfig.heartbeat);

  return {
    enabled: asBoolean(heartbeat.enabled, true),
    intervalSec: Math.max(0, asNumber(heartbeat.intervalSec, 0)),
    wakeOnDemand: asBoolean(heartbeat.wakeOnDemand ?? heartbeat.wakeOnAssignment ?? heartbeat.wakeOnOnDemand ?? heartbeat.wakeOnAutomation, true),
    maxConcurrentRuns: normalizeMaxConcurrentRuns(heartbeat.maxConcurrentRuns),
  };
}
