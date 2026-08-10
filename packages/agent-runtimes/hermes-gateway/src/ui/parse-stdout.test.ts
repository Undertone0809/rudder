import { describe, expect, it } from "vitest";
import { parseHermesGatewayStdoutLine } from "./parse-stdout.js";

const ts = "2026-08-07T00:00:00.000Z";

describe("Hermes gateway transcript parser", () => {
  it("parses streamed deltas and terminal output from persisted event lines", () => {
    const lines = [
      '[hermes-gateway:event] run=run-1 type=message.delta data={"delta":"hello "}',
      '[hermes-gateway:event] run=run-1 type=message.delta data={"delta":"from Hermes"}',
      '[hermes-gateway:event] run=run-1 type=run.completed data={"output":"hello from Hermes"}',
    ];

    expect(lines.flatMap((line) => parseHermesGatewayStdoutLine(line, ts))).toEqual([
      { kind: "assistant", ts, text: "hello ", delta: true },
      { kind: "assistant", ts, text: "from Hermes", delta: true },
      { kind: "assistant", ts, text: "hello from Hermes" },
    ]);
  });

  it("preserves provider failures as stderr evidence", () => {
    expect(parseHermesGatewayStdoutLine(
      '[hermes-gateway:event] run=run-1 type=run.failed data={"error":"provider unavailable"}',
      ts,
    )).toEqual([{ kind: "stderr", ts, text: "provider unavailable" }]);
  });
});
