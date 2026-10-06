import { randomUUID } from "node:crypto";
import type { ActivityFilters } from "./activity.js";
import type {
  RustFoundationActor,
  RustFoundationResponse,
  createRustActorEnvelope,
} from "./rust-foundation-bridge.js";

export type RustActivityReadInput =
  | { operation: "organization"; filters: Omit<ActivityFilters, "orgId">; page?: { limit?: number; cursor?: string } }
  | { operation: "issue_activity" | "issue_runs"; issueId: string }
  | { operation: "run_issues"; runId: string };

type TransportOptions = {
  ensureStarted(): Promise<void>;
  getBaseUrl(): string | null;
  actorEnvelopeKey: string;
  requestTimeoutMs: number;
  sign: typeof createRustActorEnvelope;
  requestFailed(message: string, cause?: unknown): Error;
};

/** Read transport only: public authorization happens before dispatch, and Rust
 * owns selection/projection for old and new rows without mutation pilot gates. */
export function createRustActivityReadTransport(options: TransportOptions) {
  return async (actor: RustFoundationActor, orgId: string, input: RustActivityReadInput): Promise<RustFoundationResponse> => {
    await options.ensureStarted();
    const baseUrl = options.getBaseUrl();
    if (!baseUrl) throw options.requestFailed("Rust foundation bridge is not running");
    const requestPath = `/internal/orgs/${encodeURIComponent(orgId)}/activity-reads`;
    const body = Buffer.from(JSON.stringify(input), "utf8");
    const requestId = randomUUID();
    const envelope = options.sign({
      actor,
      organizationId: orgId,
      method: "POST",
      path: requestPath,
      action: "activity.read",
      body,
      secret: options.actorEnvelopeKey,
      requestId,
    });
    try {
      const response = await fetch(`${baseUrl}${requestPath}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-rudder-actor-envelope": JSON.stringify(envelope),
          "x-rudder-request-id": requestId,
        },
        body: body as unknown as BodyInit,
        signal: AbortSignal.timeout(options.requestTimeoutMs),
      });
      return {
        status: response.status,
        contentType: response.headers.get("content-type") ?? "application/json",
        body: Buffer.from(await response.arrayBuffer()),
      };
    } catch (cause) {
      throw options.requestFailed("Rust Activity read request failed", cause);
    }
  };
}
