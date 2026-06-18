// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { parseWorkspaceCsvContent, serializeWorkspaceCsvRows } from "../lib/workspace-csv";

describe("workspace CSV parsing", () => {
  it("round-trips quoted commas, quotes, embedded newlines, and CRLF endings", () => {
    const csv = [
      "name,notes",
      "\"Ava, Q.\",\"Needs \"\"careful\"\" review\"",
      "Bea,\"Line one",
      "Line two\"",
      "",
    ].join("\r\n");

    const parsed = parseWorkspaceCsvContent(csv);

    expect(parsed.lineEnding).toBe("\r\n");
    expect(parsed.hasTrailingLineBreak).toBe(true);
    expect(parsed.rows).toEqual([
      ["name", "notes"],
      ["Ava, Q.", "Needs \"careful\" review"],
      ["Bea", "Line one\r\nLine two"],
    ]);
    expect(serializeWorkspaceCsvRows(parsed.rows, parsed.lineEnding, parsed.hasTrailingLineBreak)).toBe(csv);
  });

  it("preserves literal quotes inside unquoted fields", () => {
    const parsed = parseWorkspaceCsvContent("name,notes\nAva,3\" screw");

    expect(parsed.rows).toEqual([
      ["name", "notes"],
      ["Ava", "3\" screw"],
    ]);
    expect(serializeWorkspaceCsvRows(parsed.rows)).toBe("name,notes\nAva,\"3\"\" screw\"");
  });
});
