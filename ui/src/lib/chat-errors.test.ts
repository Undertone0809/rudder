import { ApiError, ApiTimeoutError } from "@/api/client";
import { describe, expect, it } from "vitest";
import { chatErrorToast } from "./chat-errors";

describe("chat error presentation", () => {
  it.each([
    [new ApiError("provider stack trace", 500, null), "Rudder could not process the request. Try again."],
    [new ApiError("internal conflict details", 409, null), "This chat changed while the request was in progress. Refresh and try again."],
    [new ApiTimeoutError(15_000), "The request took too long. Check your connection and try again."],
    [new TypeError("Failed to fetch"), "Rudder could not be reached. Check your connection and try again."],
  ])("keeps internal failure detail out of the user message", (error, body) => {
    expect(chatErrorToast(error, "steer")).toEqual({
      title: "Could not send steer",
      body,
    });
    expect(chatErrorToast(error, "steer").body).not.toContain(error instanceof Error ? error.message : "");
  });
});
