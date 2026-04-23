import { describe, expect, it, vi } from "vitest";
import {
  createExecutionScoreId,
  createStableUuid,
  getExecutionTraceId,
  normalizeLangfuseScoreValue,
  redactLangfuseValue,
  resolveLangfuseTraceIdentity,
  updateExecutionTraceSession,
  updateExecutionTraceIO,
  updateExecutionTraceName,
} from "../langfuse.js";

describe("langfuse helpers", () => {
  it("derives deterministic trace and score ids from Rudder ids", async () => {
    expect(createStableUuid("rudder:test")).toBe(createStableUuid("rudder:test"));
    expect(createExecutionScoreId("run-1", "run_health")).toBe(createExecutionScoreId("run-1", "run_health"));
    await expect(getExecutionTraceId("run-1")).resolves.toBe(await getExecutionTraceId("run-1"));
    await expect(getExecutionTraceId("run-1")).resolves.not.toBe(await getExecutionTraceId("run-2"));
  });

  it("redacts secrets before export", () => {
    expect(
      redactLangfuseValue({
        apiKey: "sk-secret",
        nested: { token: "abc" },
        tokenCount: 42,
        allowed: "hello",
      }),
    ).toEqual({
      apiKey: "***REDACTED***",
      nested: { token: "***REDACTED***" },
      tokenCount: 42,
      allowed: "hello",
    });
  });

  it("normalizes boolean and string scores into Langfuse-compatible values", () => {
    expect(normalizeLangfuseScoreValue(true)).toEqual({ value: 1, dataType: "BOOLEAN" });
    expect(normalizeLangfuseScoreValue(0.42)).toEqual({ value: 0.42, dataType: "NUMERIC" });
    expect(normalizeLangfuseScoreValue("permission_denied")).toEqual({
      value: "permission_denied",
      dataType: "CATEGORICAL",
    });
  });

  it("writes redacted trace io without mutating blank updates", () => {
    const setTraceIO = vi.fn();
    updateExecutionTraceIO({ setTraceIO } as any, {
      input: { apiKey: "sk-secret", allowed: "hello" },
      output: "done",
    });
    expect(setTraceIO).toHaveBeenCalledWith({
      input: { apiKey: "***REDACTED***", allowed: "hello" },
      output: "done",
    });

    setTraceIO.mockClear();
    updateExecutionTraceIO({ setTraceIO } as any, {});
    expect(setTraceIO).not.toHaveBeenCalled();
  });

  it("updates trace session id only when present", () => {
    const setAttributes = vi.fn();
    updateExecutionTraceSession({ otelSpan: { setAttributes } } as any, "session-123");
    expect(setAttributes).toHaveBeenCalledWith({ "session.id": "session-123" });

    setAttributes.mockClear();
    updateExecutionTraceSession({ otelSpan: { setAttributes } } as any, "");
    expect(setAttributes).not.toHaveBeenCalled();
  });

  it("updates trace name only when present", () => {
    const setAttributes = vi.fn();
    updateExecutionTraceName({ otelSpan: { setAttributes } } as any, "issue_run:Fix login [issue-1]");
    expect(setAttributes).toHaveBeenCalledWith({
      "langfuse.trace.name": "issue_run:Fix login [issue-1]",
    });
  });

  it("resolves environment, instance, and release identity for tags and metadata", () => {
    expect(
      resolveLangfuseTraceIdentity(
        {},
        {
          environment: "prod",
          instanceId: "default",
          release: "1.2.3",
        },
      ),
    ).toEqual({
      environment: "prod",
      instanceId: "default",
      release: "1.2.3",
    });

    expect(
      resolveLangfuseTraceIdentity(
        {
          environment: "dev",
          instanceId: "dev",
        },
        {
          environment: "prod",
          instanceId: "default",
          release: "1.2.3",
        },
      ),
    ).toEqual({
      environment: "dev",
      instanceId: "dev",
      release: "1.2.3",
    });
  });
});
