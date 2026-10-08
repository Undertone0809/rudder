import type { RustFoundationActor, RustFoundationResponse } from "./rust-foundation-bridge.js";

/** Node transports authenticated public requests; Rust owns calendar data and domain rules. */
export interface CalendarNativeBridge {
  calendar?(
    actor: RustFoundationActor,
    orgId: string,
    input: Record<string, unknown>,
  ): Promise<RustFoundationResponse>;
}

export type CalendarNativeOperation =
  | "source.list" | "source.create" | "source.update" | "source.delete"
  | "event.list" | "event.create" | "event.detail" | "event.update" | "event.delete";

export function calendarNativeRequest(
  body: unknown,
  auditRunId: string | null,
): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { operation: null, auditRunId, invalidInput: body };
  }
  return { ...(body as Record<string, unknown>), auditRunId };
}

export function sendCalendarNativeResponse(
  response: RustFoundationResponse,
  send: (status: number, contentType: string, body: Buffer) => void,
) {
  send(response.status, response.contentType, response.body);
}
