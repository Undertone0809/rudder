// @vitest-environment jsdom

import { act, useRef, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useChatStreamBottomScroll } from "./Chat.initial-scroll";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type ResizeObserverInstance = {
  callback: ResizeObserverCallback;
  connected: boolean;
};

const resizeObservers: ResizeObserverInstance[] = [];
const roots: Array<{ container: HTMLDivElement; root: Root }> = [];
const animationFrames = new Map<number, FrameRequestCallback>();
let nextAnimationFrameId = 0;

class ResizeObserverMock {
  private readonly instance: ResizeObserverInstance;

  constructor(callback: ResizeObserverCallback) {
    this.instance = { callback, connected: true };
    resizeObservers.push(this.instance);
  }

  observe() {}

  unobserve() {}

  disconnect() {
    this.instance.connected = false;
  }
}

function StreamScrollProbe({
  conversationId,
  streamKey,
  scrollToBottom,
}: {
  conversationId: string | null;
  streamKey: string | null;
  scrollToBottom: (element: HTMLDivElement) => void;
}) {
  const scrollElementRef = useRef<HTMLDivElement | null>(null);
  useChatStreamBottomScroll({
    conversationId,
    streamKey,
    scrollElementRef,
    scrollToBottom,
  });
  return (
    <div ref={scrollElementRef} data-testid="scroll-region">
      <div data-testid="timeline-content" />
    </div>
  );
}

async function mountProbe(props: ComponentProps<typeof StreamScrollProbe>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push({ container, root });
  await act(async () => root.render(<StreamScrollProbe {...props} />));
  return container.querySelector<HTMLDivElement>("[data-testid='scroll-region']")!;
}

function flushAnimationFrames() {
  while (animationFrames.size > 0) {
    const [id, callback] = animationFrames.entries().next().value as [number, FrameRequestCallback];
    animationFrames.delete(id);
    callback(0);
  }
}

function setScrollMetrics(element: HTMLDivElement, values: { height: number; viewport: number }) {
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, get: () => values.height },
    clientHeight: { configurable: true, get: () => values.viewport },
  });
}

afterEach(() => {
  for (const { container, root } of roots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  resizeObservers.splice(0);
  animationFrames.clear();
  nextAnimationFrameId = 0;
  vi.unstubAllGlobals();
});

describe("useChatStreamBottomScroll", () => {
  it("follows a new reply while active and keeps the final response in view", async () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = ++nextAnimationFrameId;
      animationFrames.set(id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => animationFrames.delete(id));

    const scrollToBottom = vi.fn((element: HTMLDivElement) => {
      element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    });
    const scrollElement = await mountProbe({
      conversationId: "chat-1",
      streamKey: null,
      scrollToBottom,
    });
    const metrics = { height: 500, viewport: 300 };
    setScrollMetrics(scrollElement, metrics);

    await act(async () => roots[0]!.root.render(
      <StreamScrollProbe conversationId="chat-1" streamKey="stream-1" scrollToBottom={scrollToBottom} />,
    ));
    flushAnimationFrames();
    expect(scrollToBottom).toHaveBeenCalled();
    expect(scrollElement.scrollTop).toBe(200);

    metrics.height = 700;
    const observer = resizeObservers.find((item) => item.connected)!;
    await act(async () => observer.callback([], {} as ResizeObserver));
    flushAnimationFrames();
    expect(scrollElement.scrollTop).toBe(400);

    scrollElement.dispatchEvent(new Event("wheel"));
    flushAnimationFrames();
    metrics.height = 800;
    await act(async () => observer.callback([], {} as ResizeObserver));
    flushAnimationFrames();
    expect(scrollElement.scrollTop).toBe(500);

    const callsBeforeFinish = scrollToBottom.mock.calls.length;
    await act(async () => roots[0]!.root.render(
      <StreamScrollProbe conversationId="chat-1" streamKey={null} scrollToBottom={scrollToBottom} />,
    ));
    expect(scrollToBottom.mock.calls.length).toBeGreaterThan(callsBeforeFinish);
    expect(scrollElement.scrollTop).toBe(500);
  });

  it("does not pull the operator back to the bottom after they scroll up", async () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = ++nextAnimationFrameId;
      animationFrames.set(id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => animationFrames.delete(id));

    const scrollToBottom = vi.fn((element: HTMLDivElement) => {
      element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    });
    const scrollElement = await mountProbe({
      conversationId: "chat-1",
      streamKey: null,
      scrollToBottom,
    });
    setScrollMetrics(scrollElement, { height: 500, viewport: 300 });

    await act(async () => roots[0]!.root.render(
      <StreamScrollProbe conversationId="chat-1" streamKey="stream-1" scrollToBottom={scrollToBottom} />,
    ));
    flushAnimationFrames();
    scrollElement.scrollTop = 0;
    scrollElement.dispatchEvent(new Event("wheel"));
    flushAnimationFrames();

    const callsBeforeFinish = scrollToBottom.mock.calls.length;
    await act(async () => roots[0]!.root.render(
      <StreamScrollProbe conversationId="chat-1" streamKey={null} scrollToBottom={scrollToBottom} />,
    ));
    expect(scrollToBottom).toHaveBeenCalledTimes(callsBeforeFinish);
    expect(scrollElement.scrollTop).toBe(0);
  });
});
