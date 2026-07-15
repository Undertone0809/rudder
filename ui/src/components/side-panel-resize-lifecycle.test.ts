// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { startSidePanelResizeLifecycle } from "./side-panel-resize-lifecycle";

function pointerEvent(type: string, pointerId = 7): Event {
  const event = new Event(type);
  Object.defineProperty(event, "pointerId", { value: pointerId });
  return event;
}

function createHandle() {
  const handle = document.createElement("div");
  const setPointerCapture = vi.fn();
  const hasPointerCapture = vi.fn(() => true);
  const releasePointerCapture = vi.fn();
  Object.assign(handle, {
    setPointerCapture,
    hasPointerCapture,
    releasePointerCapture,
  });
  return { handle, releasePointerCapture, setPointerCapture };
}

afterEach(() => {
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
});

describe("Side Panel resize lifecycle", () => {
  it.each([
    ["pointer cancellation", () => window.dispatchEvent(pointerEvent("pointercancel"))],
    ["pointer capture loss", (handle: HTMLElement) => handle.dispatchEvent(pointerEvent("lostpointercapture"))],
    ["window focus loss", () => window.dispatchEvent(new Event("blur"))],
  ])("cleans up after %s", (_name, cancel) => {
    const { handle, releasePointerCapture, setPointerCapture } = createHandle();
    const onMove = vi.fn();
    const onStop = vi.fn();
    document.body.style.cursor = "wait";
    document.body.style.userSelect = "text";

    const lifecycle = startSidePanelResizeLifecycle({
      onMove,
      onStop,
      pointerId: 7,
      resizeHandle: handle,
    });

    expect(lifecycle.isActive()).toBe(true);
    expect(document.body.style.cursor).toBe("col-resize");
    expect(document.body.style.userSelect).toBe("none");
    expect(setPointerCapture).toHaveBeenCalledWith(7);

    cancel(handle);

    expect(lifecycle.isActive()).toBe(false);
    expect(document.body.style.cursor).toBe("wait");
    expect(document.body.style.userSelect).toBe("text");
    expect(releasePointerCapture).toHaveBeenCalledWith(7);
    expect(onStop).toHaveBeenCalledTimes(1);

    window.dispatchEvent(pointerEvent("pointermove"));
    window.dispatchEvent(new MouseEvent("mousemove"));
    handle.dispatchEvent(pointerEvent("lostpointercapture"));
    lifecycle.stop();

    expect(onMove).not.toHaveBeenCalled();
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("uses the same idempotent stop for normal completion and component unmount", () => {
    const { handle } = createHandle();
    const onMove = vi.fn();
    const onStop = vi.fn();
    const lifecycle = startSidePanelResizeLifecycle({
      onMove,
      onStop,
      pointerId: null,
      resizeHandle: handle,
    });

    lifecycle.stop();
    lifecycle.stop();
    window.dispatchEvent(pointerEvent("pointermove"));
    window.dispatchEvent(new MouseEvent("mousemove"));

    expect(lifecycle.isActive()).toBe(false);
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
    expect(onMove).not.toHaveBeenCalled();
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});
