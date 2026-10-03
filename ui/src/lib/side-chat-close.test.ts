import { ApiError } from "@/api/client";
import { getTerminalSideChatCloseStatus, isKeptSideChatConflict } from "@/lib/side-chat-close";
import { describe, expect, it } from "vitest";

describe("Side Chat close conflicts", () => {
  it("recognizes only the stable kept code as a terminal 409", () => {
    const kept = new ApiError("Conflict", 409, { details: { code: "side_chat_kept" } });
    const active = new ApiError("Conflict", 409, { details: { code: "active_generation" } });
    const untyped = new ApiError("Conflict", 409, null);

    expect(isKeptSideChatConflict(kept)).toBe(true);
    expect(getTerminalSideChatCloseStatus(kept)).toBe(409);
    expect(isKeptSideChatConflict(active)).toBe(false);
    expect(getTerminalSideChatCloseStatus(active)).toBeNull();
    expect(getTerminalSideChatCloseStatus(untyped)).toBeNull();
  });

  it("keeps missing and gone Side Chats terminal without treating other errors as closeable", () => {
    expect(getTerminalSideChatCloseStatus(new ApiError("Missing", 404, null))).toBe(404);
    expect(getTerminalSideChatCloseStatus(new ApiError("Gone", 410, null))).toBe(410);
    expect(getTerminalSideChatCloseStatus(new ApiError("Unavailable", 503, null))).toBeNull();
    expect(getTerminalSideChatCloseStatus(new Error("Conflict"))).toBeNull();
  });
});
