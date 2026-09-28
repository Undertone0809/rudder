import { ApiError } from "@/api/client";

export function isKeptSideChatConflict(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 409) return false;
  if (!error.body || typeof error.body !== "object" || !("details" in error.body)) return false;
  const details = (error.body as { details?: unknown }).details;
  return Boolean(details && typeof details === "object" && "code" in details
    && (details as { code?: unknown }).code === "side_chat_kept");
}

export function getTerminalSideChatCloseStatus(error: unknown): 404 | 409 | 410 | null {
  if (!(error instanceof ApiError)) return null;
  if (error.status === 404 || error.status === 410) return error.status;
  return error.status === 409 && isKeptSideChatConflict(error) ? 409 : null;
}
