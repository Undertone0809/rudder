import { describe, expect, it } from "vitest";
import {
  parseShortRef,
  shortRefFor,
} from "./short-refs.js";

describe("short refs", () => {
  it("builds typed compact refs from UUIDs", () => {
    expect(shortRefFor("agent", "d573266f-af95-44e6-9303-e903a54662b8")).toBe("agt_d573266f");
    expect(shortRefFor("issue_comment", "091492ab-3d85-4fcb-b066-1db769eed56d")).toBe("cmt_091492ab");
  });

  it("parses typed compact refs without accepting bare prefixes", () => {
    expect(parseShortRef("agt_d573266f")).toEqual({
      kind: "agent",
      prefix: "d573266f",
      ref: "agt_d573266f",
    });
    expect(parseShortRef("cmt_091492ab")).toEqual({
      kind: "issue_comment",
      prefix: "091492ab",
      ref: "cmt_091492ab",
    });
    expect(parseShortRef("d573266f")).toBeNull();
    expect(parseShortRef("agt_")).toBeNull();
  });
});
