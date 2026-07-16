export type SidePanelResizeMoveEvent = PointerEvent | MouseEvent;

interface StartSidePanelResizeLifecycleOptions {
  onMove: (event: SidePanelResizeMoveEvent) => void;
  onStop: () => void;
  pointerId: number | null;
  resizeHandle: HTMLElement;
}

export interface SidePanelResizeLifecycle {
  isActive: () => boolean;
  stop: () => void;
}

export function startSidePanelResizeLifecycle({
  onMove,
  onStop,
  pointerId,
  resizeHandle,
}: StartSidePanelResizeLifecycleOptions): SidePanelResizeLifecycle {
  let active = true;
  const previousCursor = document.body.style.cursor;
  const previousUserSelect = document.body.style.userSelect;

  const stop = () => {
    if (!active) return;
    active = false;

    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", stop);
    window.removeEventListener("pointercancel", stop);
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", stop);
    window.removeEventListener("blur", stop);
    resizeHandle.removeEventListener("lostpointercapture", onLostPointerCapture);

    if (pointerId !== null) {
      try {
        if (resizeHandle.hasPointerCapture(pointerId)) resizeHandle.releasePointerCapture(pointerId);
      } catch {
        // Capture can already be gone after cancellation or window focus loss.
      }
    }

    document.body.style.cursor = previousCursor;
    document.body.style.userSelect = previousUserSelect;
    onStop();
  };

  const onLostPointerCapture = (event: PointerEvent) => {
    if (pointerId === null || event.pointerId === pointerId) stop();
  };

  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", stop, { once: true });
  window.addEventListener("pointercancel", stop, { once: true });
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", stop, { once: true });
  window.addEventListener("blur", stop, { once: true });
  resizeHandle.addEventListener("lostpointercapture", onLostPointerCapture);

  if (pointerId !== null) {
    try {
      resizeHandle.setPointerCapture(pointerId);
    } catch {
      // Window listeners and the drag shield still keep the lifecycle bounded.
    }
  }

  return {
    isActive: () => active,
    stop,
  };
}
