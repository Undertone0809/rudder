import { describe, expect, it, vi } from "vitest";
import { ConditionalFileSaveQueue } from "./conditional-file-save-queue";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("ConditionalFileSaveQueue", () => {
  it("coalesces a duplicate flush and advances the baseline for a newer draft", async () => {
    const first = deferred<{ content: string }>();
    const save = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ content: "draft B" });
    const queue = new ConditionalFileSaveQueue<{ content: string }>({
      save,
      savedContent: (result) => result.content,
    });
    queue.seed("a.md", "server");

    queue.enqueue("a.md", "draft A", "server");
    queue.enqueue("a.md", "draft A", "server");
    queue.enqueue("a.md", "draft B", "server");
    first.resolve({ content: "draft A" });
    await queue.whenIdle();

    expect(save).toHaveBeenNthCalledWith(1, {
      filePath: "a.md",
      content: "draft A",
      expectedContent: "server",
    });
    expect(save).toHaveBeenNthCalledWith(2, {
      filePath: "a.md",
      content: "draft B",
      expectedContent: "draft A",
    });
  });

  it("keeps conflicts scoped to their file and continues another file", async () => {
    const onError = vi.fn();
    const save = vi.fn(async (request: {
      filePath: string;
      content: string;
      expectedContent: string;
    }) => {
      if (request.filePath === "a.md") throw new Error("conflict");
      return { content: request.content };
    });
    const queue = new ConditionalFileSaveQueue<{ content: string }>({
      save,
      savedContent: (result) => result.content,
      onError,
      isConflict: () => true,
    });
    queue.seed("a.md", "server A");
    queue.seed("b.md", "server B");

    queue.enqueue("a.md", "local A", "server A");
    queue.enqueue("b.md", "local B", "server B");
    await queue.whenIdle();

    expect(queue.isConflicted("a.md")).toBe(true);
    expect(queue.isConflicted("b.md")).toBe(false);
    expect(save).toHaveBeenCalledWith({
      filePath: "b.md",
      content: "local B",
      expectedContent: "server B",
    });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      filePath: "a.md",
      content: "local A",
    }));
  });

  it("does not freeze a file after a transient failure or lose its local draft", async () => {
    const save = vi.fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce({ content: "local B" });
    const queue = new ConditionalFileSaveQueue<{ content: string }>({
      save,
      savedContent: (result) => result.content,
      isConflict: () => false,
    });
    queue.seed("a.md", "server");

    queue.enqueue("a.md", "local A", "server");
    await queue.whenIdle();
    expect(queue.isConflicted("a.md")).toBe(false);
    expect(queue.localContent("a.md")).toBe("local A");

    queue.enqueue("a.md", "local B", "server");
    await queue.whenIdle();
    expect(save).toHaveBeenLastCalledWith({
      filePath: "a.md",
      content: "local B",
      expectedContent: "server",
    });
    expect(queue.localContent("a.md")).toBeNull();
  });

  it("retries the same failed draft without starting an automatic retry loop", async () => {
    const save = vi.fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce({ content: "local A" });
    const queue = new ConditionalFileSaveQueue<{ content: string }>({
      save,
      savedContent: (result) => result.content,
      isConflict: () => false,
    });
    queue.seed("a.md", "server");

    queue.enqueue("a.md", "local A", "server");
    await queue.whenIdle();
    queue.enqueue("a.md", "local A", "server");
    await queue.whenIdle();
    expect(save).toHaveBeenCalledTimes(1);
    expect(queue.localContent("a.md")).toBe("local A");

    queue.retry("a.md", "local A", "server");
    await queue.whenIdle();
    expect(save).toHaveBeenNthCalledWith(2, {
      filePath: "a.md",
      content: "local A",
      expectedContent: "server",
    });
    expect(queue.localContent("a.md")).toBeNull();
  });
});
