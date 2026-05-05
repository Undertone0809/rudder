import { describe, expect, it } from "vitest";
import {
  OPERATOR_PROFILE_MORE_ABOUT_YOU_MAX_LENGTH,
  operatorProfileSettingsSchema,
} from "./instance.js";

describe("operatorProfileSettingsSchema", () => {
  it("accepts imported profile context up to the shared limit", () => {
    const value = "x".repeat(OPERATOR_PROFILE_MORE_ABOUT_YOU_MAX_LENGTH);

    expect(operatorProfileSettingsSchema.parse({ moreAboutYou: value })).toEqual({
      nickname: "",
      moreAboutYou: value,
    });
  });

  it("rejects imported profile context above the shared limit", () => {
    const value = "x".repeat(OPERATOR_PROFILE_MORE_ABOUT_YOU_MAX_LENGTH + 1);

    expect(() => operatorProfileSettingsSchema.parse({ moreAboutYou: value })).toThrow();
  });
});
