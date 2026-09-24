import { describe, expect, it, vi } from "vitest";
import { retrySideChatTerminalEvidence } from "./side-chat-runtime-admission.js";

describe("expired Side Chat terminal recovery", () => {
  it("retries a transient terminal write up to the first durable result", async () => {
    const write = vi.fn()
      .mockRejectedValueOnce(new Error("terminal transaction unavailable"))
      .mockResolvedValueOnce({ outboxId: "outbox-1", idempotent: false });

    await expect(retrySideChatTerminalEvidence({ write })).resolves.toEqual({
      outboxId: "outbox-1",
      idempotent: false,
    });
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("bounds one recovery pass when every terminal write fails", async () => {
    const write = vi.fn().mockRejectedValue(new Error("terminal transaction unavailable"));
    const onFailure = vi.fn();

    await expect(retrySideChatTerminalEvidence({ write, attempts: 3, onFailure })).resolves.toBeNull();
    expect(write).toHaveBeenCalledTimes(3);
    expect(onFailure).toHaveBeenCalledTimes(3);
    expect(onFailure).toHaveBeenLastCalledWith(expect.any(Error), 3, false);
  });

  it("tolerates a committed terminal write whose response was lost without duplicating its event", async () => {
    let terminalEventCount = 0;
    let outboxCommitted = false;
    const write = vi.fn(async () => {
      if (outboxCommitted) return { outboxId: "outbox-1", idempotent: true };
      terminalEventCount += 1;
      outboxCommitted = true;
      throw new Error("connection lost after commit");
    });

    await expect(retrySideChatTerminalEvidence({ write })).resolves.toEqual({
      outboxId: "outbox-1",
      idempotent: true,
    });
    expect(write).toHaveBeenCalledTimes(2);
    expect(terminalEventCount).toBe(1);
  });
});
