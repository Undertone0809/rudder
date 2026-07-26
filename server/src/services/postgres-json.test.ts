import { describe, expect, it } from "vitest";
import { sanitizePostgresJsonValue } from "./postgres-json.js";

describe("sanitizePostgresJsonValue", () => {
  it("sanitizes nested values without mutating the input", () => {
    const input = {
      content: "archive\u0000binary",
      nested: ["value\u0000tail"],
    };

    expect(sanitizePostgresJsonValue(input)).toEqual({
      content: "archive\uFFFDbinary",
      nested: ["value\uFFFDtail"],
    });
    expect(input.content).toBe("archive\u0000binary");
  });

  it("preserves colliding object keys after NUL replacement", () => {
    expect(sanitizePostgresJsonValue({
      "\u0000key": "nul",
      "\uFFFDkey": "replacement",
    })).toEqual({
      "\uFFFDkey": "nul",
      "\uFFFDkey-1": "replacement",
    });
  });
});
