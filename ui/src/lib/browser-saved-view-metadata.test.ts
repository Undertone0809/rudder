import { describe, expect, it, vi } from "vitest";
import {
  createBrowserSavedViewMetadataPersister,
  type BrowserSavedViewMetadata,
} from "./browser-saved-view-metadata";

const initial: BrowserSavedViewMetadata = {
  target: { kind: "browser", tabId: "tab-a", url: "https://a.example/", viewInstanceId: "view-a" },
  title: "A",
  subtitle: "https://a.example/",
  favicon: null,
};

const next = (url: string, title = url): BrowserSavedViewMetadata => ({
  target: { ...initial.target, url },
  title,
  subtitle: url,
  favicon: `data:image/svg+xml,${encodeURIComponent(title)}`,
});

describe("browser saved-view metadata persister", () => {
  it("flushes the newest metadata when navigation changes before the debounce", async () => {
    const update = vi.fn(async () => undefined);
    const persister = createBrowserSavedViewMetadataPersister({ update, debounceMs: 350 });

    persister.schedule({ organizationId: "org", savedViewId: "saved-a", metadata: next("https://b.example/"), persistedMetadata: initial });
    persister.schedule({ organizationId: "org", savedViewId: "saved-a", metadata: next("https://c.example/", "C"), persistedMetadata: initial });
    await persister.flushSavedView("saved-a");

    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith("org", "saved-a", next("https://c.example/", "C"));
  });

  it("retries a transient failure and retains the newest desired value", async () => {
    let resolveFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => { resolveFirst = resolve; });
    const update = vi.fn()
      .mockImplementationOnce(async () => {
        resolveFirst();
        throw new Error("offline");
      })
      .mockResolvedValue(undefined);
    const persister = createBrowserSavedViewMetadataPersister({ update, debounceMs: 350, retryDelaysMs: [0, 0] });

    persister.schedule({ organizationId: "org", savedViewId: "saved-a", metadata: next("https://b.example/"), persistedMetadata: initial });
    const flush = persister.flushSavedView("saved-a");
    await firstStarted;
    persister.schedule({ organizationId: "org", savedViewId: "saved-a", metadata: next("https://c.example/"), persistedMetadata: initial });
    await flush;
    await persister.flushSavedView("saved-a");

    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls.at(-1)).toEqual(["org", "saved-a", next("https://c.example/")]);
  });

  it("isolates two live saved tabs while coalescing each tab newest-wins", async () => {
    const update = vi.fn(async () => undefined);
    const persister = createBrowserSavedViewMetadataPersister({ update, debounceMs: 350 });
    const tabBInitial: BrowserSavedViewMetadata = {
      ...initial,
      target: { ...initial.target, tabId: "tab-b", viewInstanceId: "view-b" },
    };

    persister.schedule({ organizationId: "org", savedViewId: "saved-a", metadata: next("https://a.example/one"), persistedMetadata: initial });
    persister.schedule({ organizationId: "org", savedViewId: "saved-a", metadata: next("https://a.example/two"), persistedMetadata: initial });
    persister.schedule({
      organizationId: "org",
      savedViewId: "saved-b",
      metadata: { ...tabBInitial, title: "B", subtitle: "https://b.example/", target: { ...tabBInitial.target, url: "https://b.example/" } },
      persistedMetadata: tabBInitial,
    });
    await persister.flushAll();

    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls).toEqual(expect.arrayContaining([
      ["org", "saved-a", next("https://a.example/two")],
      ["org", "saved-b", expect.objectContaining({ title: "B" })],
    ]));
  });

  it("skips values already persisted by the server", async () => {
    const update = vi.fn(async () => undefined);
    const persister = createBrowserSavedViewMetadataPersister({ update });
    persister.schedule({ organizationId: "org", savedViewId: "saved-a", metadata: initial, persistedMetadata: initial });
    await persister.flushAll();
    expect(update).not.toHaveBeenCalled();
  });

  it("does not lose a return to the initially persisted URL while a newer URL is in flight", async () => {
    let releaseFirst!: () => void;
    let signalFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => { signalFirst = resolve; });
    const update = vi.fn()
      .mockImplementationOnce(async () => {
        signalFirst();
        await new Promise<void>((resolve) => { releaseFirst = resolve; });
      })
      .mockResolvedValue(undefined);
    const persister = createBrowserSavedViewMetadataPersister({ update, debounceMs: 0 });
    persister.schedule({ organizationId: "org", savedViewId: "saved-a", metadata: next("https://b.example/"), persistedMetadata: initial });
    const flush = persister.flushSavedView("saved-a");
    await firstStarted;
    persister.schedule({ organizationId: "org", savedViewId: "saved-a", metadata: initial, persistedMetadata: initial });
    releaseFirst();
    await flush;

    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls.at(-1)).toEqual(["org", "saved-a", initial]);
  });

  it("cancels queued metadata without allowing timers or flushes to update a deleted saved view", async () => {
    vi.useFakeTimers();
    try {
      const update = vi.fn(async () => undefined);
      const persister = createBrowserSavedViewMetadataPersister({ update, debounceMs: 350 });
      persister.schedule({ organizationId: "org", savedViewId: "saved-a", metadata: next("https://deleted.example/newest"), persistedMetadata: initial });

      persister.cancelSavedView("saved-a");
      await vi.advanceTimersByTimeAsync(1_000);
      await persister.flushSavedView("saved-a");
      await persister.flushAll();

      expect(update).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry a failed update after its saved view is canceled during backoff", async () => {
    vi.useFakeTimers();
    try {
      let firstAttemptStarted!: () => void;
      const firstAttempt = new Promise<void>((resolve) => { firstAttemptStarted = resolve; });
      const update = vi.fn(async () => {
        firstAttemptStarted();
        throw new Error("Saved View was deleted");
      });
      const persister = createBrowserSavedViewMetadataPersister({
        update,
        debounceMs: 0,
        retryDelaysMs: [500, 1_000],
      });
      persister.schedule({ organizationId: "org", savedViewId: "saved-a", metadata: next("https://deleted.example/retry"), persistedMetadata: initial });
      const flush = persister.flushSavedView("saved-a");
      await firstAttempt;

      persister.cancelSavedView("saved-a");
      await vi.runAllTimersAsync();
      await flush;
      await persister.flushAll();

      expect(update).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
