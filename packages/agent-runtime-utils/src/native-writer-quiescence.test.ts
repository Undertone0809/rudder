import { describe, expect, it } from "vitest";
import { hasConfirmedNativeWriterQuiescence } from "./native-writer-quiescence.js";

describe("hasConfirmedNativeWriterQuiescence", () => {
  const base = {
    exitCode: 0,
    signal: null,
    timedOut: false,
    nativeWriterQuiescence: { status: "confirmed", source: "provider_terminal" },
  } as const;

  it("accepts an observed provider terminal", () => {
    expect(hasConfirmedNativeWriterQuiescence(base)).toBe(true);
  });

  it("accepts a no-provider-start proof only for pre-submission results", () => {
    const notStarted = {
      ...base,
      submissionPhase: "pre_submission" as const,
      nativeWriterQuiescence: { status: "confirmed" as const, source: "not_started" as const },
    };

    expect(hasConfirmedNativeWriterQuiescence(notStarted)).toBe(true);
    expect(hasConfirmedNativeWriterQuiescence({ ...notStarted, submissionPhase: "indeterminate" })).toBe(false);
    expect(hasConfirmedNativeWriterQuiescence({ ...notStarted, timedOut: true })).toBe(false);
  });

  it("rejects missing, unconfirmed, suspended, or unverified-stop evidence", () => {
    expect(hasConfirmedNativeWriterQuiescence({ ...base, nativeWriterQuiescence: undefined })).toBe(false);
    expect(hasConfirmedNativeWriterQuiescence({
      ...base,
      nativeWriterQuiescence: { status: "unconfirmed", reason: "stop not observed" },
    })).toBe(false);
    expect(hasConfirmedNativeWriterQuiescence({ ...base, networkSuspension: {} as never })).toBe(false);
    expect(hasConfirmedNativeWriterQuiescence({ ...base, errorCode: "hermes_product_rpc_cancel_unverified" })).toBe(false);
  });

  it("requires stop or process-exit evidence after timeout", () => {
    expect(hasConfirmedNativeWriterQuiescence({ ...base, timedOut: true })).toBe(false);
    expect(hasConfirmedNativeWriterQuiescence({
      ...base,
      timedOut: true,
      signal: "SIGTERM",
      nativeWriterQuiescence: { status: "confirmed", source: "process_exit" },
    })).toBe(true);
    expect(hasConfirmedNativeWriterQuiescence({
      ...base,
      exitCode: null,
      nativeWriterQuiescence: { status: "confirmed", source: "process_exit" },
    })).toBe(false);
  });
});
