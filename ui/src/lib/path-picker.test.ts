import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client";
import { getPathPickerFailureMessage, shouldFallbackToManualPathInstructions } from "./path-picker";

describe("path picker helpers", () => {
  it("falls back to manual instructions for unsupported picker responses", () => {
    expect(
      shouldFallbackToManualPathInstructions(
        new ApiError("Native path picker is unavailable.", 422, { error: "Native path picker is unavailable." }),
      ),
    ).toBe(true);
    expect(
      shouldFallbackToManualPathInstructions(
        new ApiError("Forbidden", 403, { error: "Forbidden" }),
      ),
    ).toBe(false);
  });

  it("extracts an actionable failure message", () => {
    expect(getPathPickerFailureMessage(new Error("Something broke"))).toBe("Something broke");
    expect(getPathPickerFailureMessage(null)).toBe("Couldn't open the system path picker.");
  });
});
