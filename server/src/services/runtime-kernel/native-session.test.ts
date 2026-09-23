import { describe, expect, it } from "vitest";
import {
  assertRuntimeIdentity,
  RuntimeIdentityContractError,
  runtimeTypeFromSelector,
  selectorForRuntime,
  nativeSessionIdFromResult,
} from "./native-session.js";

describe("native session runtime identity", () => {
  it("never substitutes a display label for the native session identity", () => {
    const result = { exitCode: 0, signal: null, timedOut: false, sessionDisplayId: "Friendly title" };
    expect(nativeSessionIdFromResult({ ...result, sessionId: "native-id" })).toBe("native-id");
    expect(nativeSessionIdFromResult(result)).toBeNull();
  });
  it("freezes each Run's native start boundary instead of reading the mutable session head", () => {
    const input = { sessionId: "session", executionRef: "assistant-2", inputCorrelationRef: "rudder-input",
      runId: "run-2", result: { exitCode: 0, signal: null, timedOut: false, resultJson: { previousLeafId: "assistant-1", startExclusiveUuid: "uuid-1", userMessageId: "native-user-2" } } };
    expect(selectorForRuntime({ ...input, runtimeType: "pi_local" })).toMatchObject({
      fromExclusive: "assistant-1", throughInclusive: "assistant-2",
    });
    expect(selectorForRuntime({ ...input, runtimeType: "claude_local" })).toMatchObject({
      startExclusiveUuid: "uuid-1", throughInclusiveUuid: "assistant-2",
    });
    expect(selectorForRuntime({ ...input, runtimeType: "opencode_local" })).toMatchObject({
      userMessageId: "native-user-2", terminalMessageIds: ["assistant-2"],
    });
  });
  it("carries Hermes product-history row ranges into the Run selector", () => {
    const selector = selectorForRuntime({
      runtimeType: "hermes_gateway",
      sessionId: "hermes-session",
      executionRef: null,
      inputCorrelationRef: "rudder-input",
      runId: "run-hermes",
      result: {
        exitCode: 0,
        signal: null,
        timedOut: false,
        resultJson: {
          providerTurnId: "hermes-turn",
          transcriptBoundary: {
            status: "exact",
            sourceRangeRef: "{\"version\":1,\"status\":\"exact\"}",
          },
        },
      },
    });
    expect(selector).toMatchObject({
      kind: "hermes_execution",
      providerExecutionRef: "hermes-turn",
      sourceRangeRef: "{\"version\":1,\"status\":\"exact\"}",
      boundaryStatus: "exact",
    });
  });
  it("rejects a segment that belongs to a different runtime than its binding/driver", () => {
    expect(() => assertRuntimeIdentity({
      bindingRuntimeType: "codex_local",
      segmentRuntimeType: "pi_local",
      driverRuntimeType: "codex_local",
      context: "mixed test",
    })).toThrowError(new RuntimeIdentityContractError(
      "mixed test: runtime identity mismatch (binding.runtimeType=codex_local, segment.runtimeType=pi_local, driver.runtimeType=codex_local)",
    ));
  });

  it("rejects a selector/driver mismatch even when binding and segment agree", () => {
    expect(() => assertRuntimeIdentity({
      bindingRuntimeType: "codex_local",
      segmentRuntimeType: "codex_local",
      driverRuntimeType: "codex_local",
      selectorRuntimeType: "claude_local",
    })).toThrow(/runtime identity mismatch/);
  });

  it("derives provider runtime identity from native selector kinds", () => {
    expect(runtimeTypeFromSelector({ kind: "codex_turn" })).toBe("codex_local");
    expect(runtimeTypeFromSelector({ kind: "pi_branch_range" })).toBe("pi_local");
    expect(runtimeTypeFromSelector({ kind: "native_execution", runtimeType: "custom_local" })).toBe("custom_local");
    expect(runtimeTypeFromSelector({ kind: "pending" })).toBeNull();
  });
});
