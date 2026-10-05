import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { createWorkflowDeadline } from "./installed-public-ingress-deadline.mjs";

function waitForAbort(signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
}

describe("installed public ingress workflow deadline", () => {
  it("retains external cancellation even after cleanup internally aborted the work signal", () => {
    const signals = new EventEmitter();
    const deadline = createWorkflowDeadline({ totalTimeoutMs: 2000, cleanupReserveMs: 500, signals });
    try {
      deadline.beginCleanup();
      assert.equal(deadline.externalCancellationReason, null);
      signals.emit("SIGTERM");
      assert.match(deadline.externalCancellationReason.message, /SIGTERM/u);
    } finally { deadline.dispose(); }
  });
  it("aborts workflow work before the hard deadline and leaves cleanup time", async () => {
    const deadline = createWorkflowDeadline({
      totalTimeoutMs: 500,
      cleanupReserveMs: 350,
      signals: null,
    });
    try {
      const firstStepTimeout = deadline.stepTimeout(10_000);
      assert.ok(firstStepTimeout > 0 && firstStepTimeout <= 150);
      await waitForAbort(deadline.signal);
      assert.match(deadline.signal.reason.message, /cleanup reserve/u);
      assert.ok(deadline.remainingMs() > 0);
      assert.throws(() => deadline.stepTimeout(100), /workflow deadline reached/u);
      assert.ok(deadline.beginCleanup() > 0);
      assert.ok(deadline.stepTimeout(10_000) <= deadline.remainingMs());
    } finally {
      deadline.dispose();
    }
  });

  it("turns SIGTERM into workflow cancellation without exiting the process", () => {
    const signals = new EventEmitter();
    const deadline = createWorkflowDeadline({
      totalTimeoutMs: 2_000,
      cleanupReserveMs: 500,
      signals,
    });
    try {
      signals.emit("SIGTERM");
      assert.equal(deadline.signal.aborted, true);
      assert.match(deadline.signal.reason.message, /SIGTERM/u);
      assert.ok(deadline.beginCleanup() > 0);
    } finally {
      deadline.dispose();
    }
    assert.equal(signals.listenerCount("SIGINT"), 0);
    assert.equal(signals.listenerCount("SIGTERM"), 0);
  });

  it("turns SIGINT into workflow cancellation", () => {
    const signals = new EventEmitter();
    const deadline = createWorkflowDeadline({
      totalTimeoutMs: 2_000,
      cleanupReserveMs: 500,
      signals,
    });
    try {
      signals.emit("SIGINT");
      assert.equal(deadline.signal.aborted, true);
      assert.match(deadline.signal.reason.message, /SIGINT/u);
    } finally {
      deadline.dispose();
    }
  });

  it("keeps cleanup waits bounded by the same hard deadline", async () => {
    const deadline = createWorkflowDeadline({
      totalTimeoutMs: 2_000,
      cleanupReserveMs: 700,
      signals: null,
    });
    try {
      const cleanupBudget = deadline.beginCleanup();
      assert.ok(cleanupBudget > 0 && cleanupBudget <= 2_000);
      assert.ok(deadline.stepTimeout(10_000) <= cleanupBudget);
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.ok(deadline.remainingMs() < cleanupBudget);
      assert.ok(deadline.stepTimeout(10_000) <= deadline.remainingMs());
    } finally {
      deadline.dispose();
    }
  });

  it("disposal clears the timer and signal listeners", async () => {
    const signals = new EventEmitter();
    const deadline = createWorkflowDeadline({
      totalTimeoutMs: 400,
      cleanupReserveMs: 300,
      signals,
    });
    deadline.dispose();
    await new Promise((resolve) => setTimeout(resolve, 140));
    assert.equal(deadline.signal.aborted, false);
    assert.equal(signals.listenerCount("SIGINT"), 0);
    assert.equal(signals.listenerCount("SIGTERM"), 0);
    assert.ok(deadline.remainingMs() > 0);
  });

  it("rejects invalid or unbounded deadline settings", () => {
    assert.throws(() => createWorkflowDeadline({ totalTimeoutMs: 0 }), /positive safe integer/u);
    assert.throws(() => createWorkflowDeadline({ totalTimeoutMs: 1_200_001 }), /must not exceed/u);
    assert.throws(() => createWorkflowDeadline({ totalTimeoutMs: 1_000, cleanupReserveMs: 1_000 }), /less than/u);
    assert.throws(() => createWorkflowDeadline({ totalTimeoutMs: 1_000, cleanupReserveMs: 0 }), /positive safe integer/u);
    assert.throws(() => createWorkflowDeadline({ totalTimeoutMs: 1_000, cleanupReserveMs: -1 }), /positive safe integer/u);
  });
});
