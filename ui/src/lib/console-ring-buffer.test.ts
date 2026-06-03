import { afterEach, describe, expect, it, vi } from "vitest";

describe("ConsoleRingBuffer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("captures recent warnings and restores the console methods", async () => {
    vi.resetModules();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ConsoleRingBuffer } = await import("./console-ring-buffer");

    ConsoleRingBuffer.install();
    console.warn("route stalled", { path: "/issues/NEW-8" });

    expect(ConsoleRingBuffer.formatRecent()).toContain("WARN: route stalled");
    expect(ConsoleRingBuffer.formatRecent()).toContain("/issues/NEW-8");

    ConsoleRingBuffer.uninstall();
    expect(console.warn).toBe(warnSpy);
  });
});
