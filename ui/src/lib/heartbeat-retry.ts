import type { HeartbeatRun } from "@rudderhq/shared";
import { heartbeatsApi } from "../api/heartbeats";

export async function retryHeartbeatRun(run: Pick<HeartbeatRun, "id">) {
  return heartbeatsApi.retry(run.id);
}
