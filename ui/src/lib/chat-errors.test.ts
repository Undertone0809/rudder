import { ApiError, ApiTimeoutError } from "@/api/client";
import { describe, expect, it } from "vitest";
import { chatErrorToast } from "./chat-errors";

describe("chat error presentation", () => {
  it("explains that an identical send is still being accepted", () => {
    const error = new ApiError(
      "This message is already being sent. Try again shortly.",
      409,
      {
        details: {
          code: "chat_send_in_progress",
          phase: "message_acceptance",
        },
      },
    );

    expect(chatErrorToast(error)).toEqual({
      title: "Could not send message",
      body: "This message is already being sent. Try again shortly.",
    });
  });

  it("turns an annotation range mismatch into a safe recovery instruction", () => {
    const error = new ApiError(
      "Annotation selected text does not exactly match its rendered Markdown source range",
      422,
      {
        error: "Annotation selected text does not exactly match its rendered Markdown source range",
        details: {
          code: "chat_annotation_selection_mismatch",
          phase: "annotation_validation",
        },
      },
    );

    expect(chatErrorToast(error)).toEqual({
      title: "Could not send message",
      body: "The selected response text changed. Re-select the highlighted text and try again.",
    });
  });

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
