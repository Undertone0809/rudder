export const ACTIVE_CHAT_GENERATION_STATUSES = [
  "starting",
  "active",
  "running",
  "waiting_for_network",
  "tool_busy",
  "closing",
  "stop_requested",
  "stopping",
] as const;

export const NATIVE_STEER_GENERATION_STATUSES = ["starting", "active", "running", "tool_busy"] as const;
export const SERVER_QUEUE_RUNNING_STATUSES = ["dequeue_claimed", "running_next"] as const;
export const CHAT_GENERATION_CONTROL_LEASE_MS = 30_000;
