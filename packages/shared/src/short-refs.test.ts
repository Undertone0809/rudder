import { describe, expect, it } from "vitest";
import {
  parseShortRef,
  shortRefFor,
} from "./short-refs.js";

describe("short refs", () => {
  it("builds typed compact refs from UUIDs", () => {
    expect(shortRefFor("agent", "d573266f-af95-44e6-9303-e903a54662b8")).toBe("agt_d573266f");
    expect(shortRefFor("chat", "14ff96a7-2518-456a-8aae-480360f0d9aa")).toBe("cht_14ff96a7");
    expect(shortRefFor("issue_comment", "091492ab-3d85-4fcb-b066-1db769eed56d")).toBe("cmt_091492ab");
    expect(shortRefFor("run", "609695f1-f90a-4b17-be61-4f0c6fe37c42")).toBe("run_609695f1");
    expect(shortRefFor("message", "4a6dcb93-e3b8-4ab8-a56e-8ad9bc5e24a2")).toBe("msg_4a6dcb93");
    expect(shortRefFor("project", "d573266f-af95-44e6-9303-e903a54662b8")).toBe("prj_d573266f");
    expect(shortRefFor("goal", "14ff96a7-2518-456a-8aae-480360f0d9aa")).toBe("gol_14ff96a7");
  });

  it("parses typed compact refs without accepting bare prefixes", () => {
    expect(parseShortRef("agt_d573266f")).toEqual({
      kind: "agent",
      prefix: "d573266f",
      ref: "agt_d573266f",
    });
    expect(parseShortRef("CHT_14FF96A7")).toEqual({
      kind: "chat",
      prefix: "14ff96a7",
      ref: "cht_14ff96a7",
    });
    expect(parseShortRef("cmt_091492ab")).toEqual({
      kind: "issue_comment",
      prefix: "091492ab",
      ref: "cmt_091492ab",
    });
    expect(parseShortRef("RUN_609695F1")).toEqual({
      kind: "run",
      prefix: "609695f1",
      ref: "run_609695f1",
    });
    expect(parseShortRef("msg_4a6dcb93")).toEqual({
      kind: "message",
      prefix: "4a6dcb93",
      ref: "msg_4a6dcb93",
    });
    expect(parseShortRef("d573266f")).toBeNull();
    expect(parseShortRef("agt_")).toBeNull();
  });
});
