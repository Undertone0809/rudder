import type { Response } from "express";
import { HttpError } from "../errors.js";
import type { RustFoundationActor, RustFoundationBridge } from "./rust-foundation-bridge.js";

export type LiveRunReadInput = {
  issueId: string | null;
  goalId: string | null;
  minCount: number;
};

/** Every legacy and new run uses native selection. A bridge outage must never
 * quietly revive the old Node business query or return an empty success. */
export async function sendLiveRunRead(
  res: Response,
  bridge: RustFoundationBridge | undefined,
  actor: RustFoundationActor,
  orgId: string,
  input: LiveRunReadInput,
): Promise<void> {
  if (!bridge?.liveRunRead) throw new HttpError(503, "Rust live-run reads are unavailable");
  let response;
  try {
    response = await bridge.liveRunRead(actor, orgId, input);
  } catch {
    throw new HttpError(503, "Rust live-run reads are unavailable");
  }
  res.status(response.status).type(response.contentType).send(response.body);
}
