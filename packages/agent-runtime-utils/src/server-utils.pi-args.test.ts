import { describe, expect, it } from "vitest";
import { assertPersistablePiRpcArgs } from "./server-utils.pi-args.js";

describe("persistable Pi native RPC arguments", () => {
  it("allows the exact managed transport arguments", () => {
    expect(() => assertPersistablePiRpcArgs([
      "--append-system-prompt", "Rudder operating contract", "--provider", "openai",
      "--model", "gpt-5.6-luna", "--thinking", "high", "--tools", "read,bash",
      "--extension", "/managed/rudder-tools.ts", "--no-skills", "--skill", "/managed/skills",
    ])).not.toThrow();
  });

  it.each([
    ["--authorization", "value"], ["-H", "Authorization: Bearer private-value"],
    ["--header=Authorization:Bearer", "value"], ["--extension", "api_key=private-value"],
  ])("rejects an unsafe flag/value %s", (...args) => {
    expect(() => assertPersistablePiRpcArgs(args)).toThrow();
  });

  it.each([
    "sk-proj-dummySecret123456789",
    "sk-ant-api03-dummySecret123456789",
    "ghp_dummySecret123456789",
    "github_pat_dummySecret123456789",
    "xoxb-dummySecret123456789",
    "AKIAABCDEFGHIJKLMNOP",
  ])("rejects a bare credential in a managed value", (value) => {
    expect(() => assertPersistablePiRpcArgs(["--append-system-prompt", value])).toThrow();
  });
});
