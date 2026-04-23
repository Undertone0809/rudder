import type { HeartbeatRun } from "@rudder/shared";
import { heartbeatsApi } from "../api/heartbeats";

export async function retryHeartbeatRun(run: Pick<HeartbeatRun, "id">) {
  return heartbeatsApi.retry(run.id);
}
