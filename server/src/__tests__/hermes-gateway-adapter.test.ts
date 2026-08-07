import { describe, expect, it } from "vitest";
import { findServerAdapter } from "../agent-runtimes/registry.js";

describe("Hermes gateway server adapter", () => {
  it("registers the transcript parser used to replay persisted run logs", () => {
    const adapter = findServerAdapter("hermes_gateway");
    expect(adapter?.parseStdoutLine).toBeTypeOf("function");
    expect(adapter?.parseStdoutLine?.(
      '[hermes-gateway:event] run=run-1 type=message.delta data={"delta":"hello"}',
      "2026-08-07T00:00:00.000Z",
    )).toEqual([{
      kind: "assistant",
      ts: "2026-08-07T00:00:00.000Z",
      text: "hello",
      delta: true,
    }]);
  });
});
