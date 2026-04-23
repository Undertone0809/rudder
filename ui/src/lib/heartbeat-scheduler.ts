import type { Agent } from "@rudder/shared";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readBoolean(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function readNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function parseSchedulerHeartbeatPolicy(runtimeConfig: unknown) {
  const heartbeat = asRecord(asRecord(runtimeConfig)?.heartbeat) ?? {};
  return {
    enabled: readBoolean(heartbeat.enabled, false),
    intervalSec: Math.max(0, readNumber(heartbeat.intervalSec, 0)),
  };
}

export function isSchedulerStatusEligible(status: Agent["status"]) {
  return status !== "paused" && status !== "terminated" && status !== "pending_approval";
}

export function buildAgentSchedulerState(agent: Pick<Agent, "status" | "runtimeConfig">) {
  const policy = parseSchedulerHeartbeatPolicy(agent.runtimeConfig);
  return {
    heartbeatEnabled: policy.enabled,
    intervalSec: policy.intervalSec,
    schedulerActive: isSchedulerStatusEligible(agent.status) && policy.enabled && policy.intervalSec > 0,
  };
}

export function isHeartbeatToggleOn(input: {
  heartbeatEnabled: boolean;
  intervalSec: number;
}) {
  return input.heartbeatEnabled && input.intervalSec > 0;
}

export function humanizeUnderscore(value: string) {
  return value.replaceAll("_", " ");
}
