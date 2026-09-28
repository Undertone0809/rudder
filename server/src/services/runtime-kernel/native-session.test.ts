import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  assertRuntimeIdentity,
  nativeExecutionSpanCompleteness,
  nativeSessionIdFromResult,
  releaseTerminalRunRuntimeSpanWriters,
  RuntimeIdentityContractError,
  runtimeTypeFromSelector,
  selectorForRuntime,
} from "./native-session.js";

function createSpanReleaseDb() {
  const runId = "run-with-two-spans";
  const quiescedAt = new Date("2026-09-29T00:00:00.000Z");
  const run = {
    status: "failed",
    processExitedAt: quiescedAt,
    processPid: null,
  };
  const spans = [
    {
      id: "span-with-proof",
      orgId: "org-1",
      runId,
      state: "open",
      completeness: "partial",
      closedAt: null,
      writerLeaseReleasedAt: null,
      updatedAt: quiescedAt,
    },
    {
      id: "still-active-span",
      orgId: "org-1",
      runId,
      state: "open",
      completeness: "partial",
      closedAt: null,
      writerLeaseReleasedAt: null,
      updatedAt: quiescedAt,
    },
  ];
  const dialect = new PgDialect();
  let selectIndex = 0;
  const tx = {
    execute: async () => undefined,
    select: () => {
      const currentSelectIndex = selectIndex++;
      return {
        from: () => ({
          where: (condition: Parameters<PgDialect["sqlToQuery"]>[0]) => {
            if (currentSelectIndex === 0) return { limit: async () => [run] };
            const params = dialect.sqlToQuery(condition).params;
            const matchingSpans = spans.filter((span) => params.includes(span.id));
            return Promise.resolve(matchingSpans.length > 0 ? matchingSpans : spans);
          },
        }),
      };
    },
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async (condition: Parameters<PgDialect["sqlToQuery"]>[0]) => {
          const params = dialect.sqlToQuery(condition).params;
          const span = spans.find((candidate) => params.includes(candidate.id));
          if (span) Object.assign(span, values);
        },
      }),
    }),
  };

  return {
    db: { transaction: (callback: (transaction: typeof tx) => unknown) => callback(tx) },
    runId,
    quiescedAt,
    spans,
  };
}

describe("native session runtime identity", () => {
  it.each(["provider_terminal", "process_exit"] as const)("releases only the exact span named by its %s proof", async (source) => {
    const fixture = createSpanReleaseDb();
    const proof = {
      exitCode: 0,
      signal: null,
      timedOut: false,
      nativeWriterQuiescence: { status: "confirmed", source },
    } as const;

    await expect(releaseTerminalRunRuntimeSpanWriters(fixture.db as never, {
      orgId: "org-1",
      runId: fixture.runId,
      proof,
      quiescedAt: fixture.quiescedAt,
    })).resolves.toEqual([]);

    await expect(releaseTerminalRunRuntimeSpanWriters(fixture.db as never, {
      orgId: "org-1",
      runId: fixture.runId,
      spanId: "span-with-proof",
      proof,
      quiescedAt: fixture.quiescedAt,
    })).resolves.toEqual(["span-with-proof"]);

    expect(fixture.spans[0]).toMatchObject({
      state: "unresolved",
      completeness: "unknown",
      writerLeaseReleasedAt: fixture.quiescedAt,
      closedAt: fixture.quiescedAt,
    });
    expect(fixture.spans[1]).toMatchObject({
      state: "open",
      completeness: "partial",
      writerLeaseReleasedAt: null,
      closedAt: null,
    });
  });

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
  it("uses the top-level provider turn id when sealing an exact Codex span", () => {
    expect(selectorForRuntime({
      runtimeType: "codex_local",
      sessionId: "codex-thread",
      executionRef: null,
      inputCorrelationRef: "rudder-input",
      runId: "run-codex",
      result: {
        exitCode: 0,
        signal: null,
        timedOut: false,
        providerTurnId: "native-turn",
      },
    })).toMatchObject({
      kind: "codex_turn",
      threadId: "codex-thread",
      turnId: "native-turn",
      runId: "run-codex",
    });
  });
  it("persists an explicit OpenCode partial boundary from observed assistant message IDs", () => {
    const selector = selectorForRuntime({
      runtimeType: "opencode_local",
      sessionId: "opencode-session",
      executionRef: null,
      inputCorrelationRef: "rudder-input",
      runId: "run-stopped",
      result: {
        exitCode: 1,
        signal: null,
        timedOut: false,
        sessionId: "opencode-session",
        resultJson: {
          userMessageId: "provider-user-r1",
          transcriptBoundary: {
            status: "partial",
            observedAssistantMessageIds: ["provider-assistant-r1"],
          },
        },
      },
    });

    expect(selector).toEqual({
      kind: "opencode_input",
      sessionId: "opencode-session",
      userMessageId: "provider-user-r1",
      terminalMessageIds: [],
      observedAssistantMessageIds: ["provider-assistant-r1"],
      completeness: "partial",
      boundaryStatus: "partial",
    });
  });
  it("marks OpenCode selectors without an explicit boundary exact only when a provider terminal message exists", () => {
    const exact = selectorForRuntime({
      runtimeType: "opencode_local",
      sessionId: "opencode-session",
      executionRef: null,
      inputCorrelationRef: "rudder-input",
      runId: "run-opencode",
      result: {
        exitCode: 0,
        signal: null,
        timedOut: false,
        resultJson: { userMessageId: "provider-user", messageId: "provider-assistant" },
      },
    });
    const unknown = selectorForRuntime({
      runtimeType: "opencode_local",
      sessionId: "opencode-session",
      executionRef: null,
      inputCorrelationRef: "rudder-input",
      runId: "run-opencode",
      result: { exitCode: 0, signal: null, timedOut: false },
    });

    expect(exact).toMatchObject({
      kind: "opencode_input",
      userMessageId: "provider-user",
      terminalMessageIds: ["provider-assistant"],
      boundaryStatus: "exact",
    });
    expect(unknown).toMatchObject({
      kind: "opencode_input",
      boundaryStatus: "unknown",
      terminalMessageIds: [],
    });
  });
  it("does not complete an OpenCode span from a provider turn id without a native session", () => {
    const result = {
      exitCode: 0,
      signal: null,
      timedOut: false,
      providerTurnId: "provider-assistant-r1",
    };

    expect(nativeExecutionSpanCompleteness({
      runtimeType: "opencode_local",
      sessionId: null,
      executionRef: "provider-assistant-r1",
      selector: { kind: "unresolved", runtimeType: "opencode_local" },
      result,
    })).toBe("unknown");
  });
  it("requires an exact provider user and assistant range before completing an OpenCode span", () => {
    const exactResult = {
      exitCode: 0,
      signal: null,
      timedOut: false,
      sessionId: "opencode-session",
      providerTurnId: "provider-assistant-r1",
      resultJson: {
        userMessageId: "provider-user-r1",
        transcriptBoundary: { status: "exact" },
      },
    };
    const exactSelector = selectorForRuntime({
      runtimeType: "opencode_local",
      sessionId: "opencode-session",
      executionRef: "provider-assistant-r1",
      inputCorrelationRef: "rudder-input",
      runId: "run-opencode",
      result: exactResult,
    });
    const unknownResult = {
      ...exactResult,
      resultJson: {
        ...exactResult.resultJson,
        transcriptBoundary: { status: "unknown" },
      },
    };

    expect(nativeExecutionSpanCompleteness({
      runtimeType: "opencode_local",
      sessionId: "opencode-session",
      executionRef: "provider-assistant-r1",
      selector: exactSelector,
      result: exactResult,
    })).toBe("complete");
    expect(nativeExecutionSpanCompleteness({
      runtimeType: "opencode_local",
      sessionId: "opencode-session",
      executionRef: "provider-assistant-r1",
      selector: selectorForRuntime({
        runtimeType: "opencode_local",
        sessionId: "opencode-session",
        executionRef: "provider-assistant-r1",
        inputCorrelationRef: "rudder-input",
        runId: "run-opencode",
        result: unknownResult,
      }),
      result: unknownResult,
    })).toBe("partial");
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
