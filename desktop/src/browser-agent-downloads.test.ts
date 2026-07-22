import { describe, expect, it, vi } from "vitest";
import {
  armAgentBrowserDownload,
  cancelAgentBrowserDownload,
  handleAgentBrowserDownload,
} from "./browser-agent-downloads.js";

describe("Browser Agent download lease", () => {
  it("denies downloads without an explicit one-shot lease", () => {
    const event = { preventDefault: vi.fn() };
    expect(handleAgentBrowserDownload(event, {} as never, {})).toBe(false);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  it("consumes one lease and reports only bounded download metadata", async () => {
    const contents = {};
    const listeners = new Map<string, (...args: any[]) => void>();
    const item = {
      getFilename: () => "../report.csv",
      getURL: () => "https://example.com/report.csv?token=hidden",
      getReceivedBytes: () => 12,
      getTotalBytes: () => 12,
      cancel: vi.fn(),
      setSavePath: vi.fn(),
      on: vi.fn((event: string, listener: (...args: any[]) => void) => { listeners.set(event, listener); }),
    };
    const pending = armAgentBrowserDownload(contents, "/tmp/browser-run", 5_000);
    const event = { preventDefault: vi.fn() };
    expect(handleAgentBrowserDownload(event, item, contents)).toBe(true);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(item.setSavePath).toHaveBeenCalledWith("/tmp/browser-run/report.csv");
    listeners.get("done")?.({}, "completed");
    await expect(pending).resolves.toMatchObject({ filename: "report.csv", state: "completed", receivedBytes: 12 });

    const secondEvent = { preventDefault: vi.fn() };
    expect(handleAgentBrowserDownload(secondEvent, item, contents)).toBe(false);
    expect(secondEvent.preventDefault).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending lease when its tab closes", async () => {
    const contents = {};
    const pending = armAgentBrowserDownload(contents, "/tmp/browser-run", 5_000);
    cancelAgentBrowserDownload(contents);
    await expect(pending).rejects.toThrow("cancelled");
  });
});
