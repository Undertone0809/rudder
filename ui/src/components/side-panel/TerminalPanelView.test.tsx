// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalPanelView, terminalErrorMessage } from "./TerminalPanelView";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  input: vi.fn(),
  resize: vi.fn(),
  outputListener: null as null | ((event: { sessionId: string; data: string }) => void),
  exitListener: null as null | ((event: { sessionId: string; code: number | null; signal: string | null; error: string | null }) => void),
  onData: null as null | ((data: string) => void),
  onResize: null as null | ((size: { cols: number; rows: number }) => void),
  write: vi.fn(),
  reset: vi.fn(),
  focus: vi.fn(),
  fit: vi.fn(),
  proposedDimensions: { cols: 80, rows: 24 } as { cols: number; rows: number } | undefined,
  resizeObserverCallback: null as ResizeObserverCallback | null,
}));

vi.mock("@/lib/desktop-shell", () => ({
  readDesktopShell: () => ({
    terminal: {
      supported: true,
      create: mocks.create,
      input: mocks.input,
      resize: mocks.resize,
      close: vi.fn(),
      onOutput: (listener: typeof mocks.outputListener) => {
        mocks.outputListener = listener;
        return () => { mocks.outputListener = null; };
      },
      onExit: (listener: typeof mocks.exitListener) => {
        mocks.exitListener = listener;
        return () => { mocks.exitListener = null; };
      },
    },
  }),
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class Terminal {
    cols = 80;
    rows = 24;
    loadAddon() {}
    open() {}
    write = mocks.write;
    reset = mocks.reset;
    focus = mocks.focus;
    dispose() {}
    onData(listener: (data: string) => void) {
      mocks.onData = listener;
      return { dispose: () => { mocks.onData = null; } };
    }
    onResize(listener: (size: { cols: number; rows: number }) => void) {
      mocks.onResize = listener;
      return { dispose: () => { mocks.onResize = null; } };
    }
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class FitAddon {
    fit = mocks.fit;
    proposeDimensions = () => mocks.proposedDimensions;
  },
}));

vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

const target = {
  kind: "terminal" as const,
  organizationId: "org-1",
  agentId: "agent-1",
  sessionId: "terminal-1",
  label: "Terminal",
};

describe("TerminalPanelView", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.create.mockReset();
    mocks.create.mockResolvedValue({ sessionId: "terminal-1", replay: "existing output\r\n", status: "running" });
    mocks.input.mockReset();
    mocks.input.mockResolvedValue(undefined);
    mocks.resize.mockReset();
    mocks.resize.mockResolvedValue(undefined);
    mocks.write.mockReset();
    mocks.reset.mockReset();
    mocks.focus.mockReset();
    mocks.fit.mockReset();
    mocks.proposedDimensions = { cols: 80, rows: 24 };
    mocks.resizeObserverCallback = null;
    vi.stubGlobal("ResizeObserver", class ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        mocks.resizeObserverCallback = callback;
      }
      observe() {}
      disconnect() {}
    });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("starts in the trusted Agent context and bridges replay, output, input, and resize by session", async () => {
    await act(async () => {
      root.render(<TerminalPanelView active target={target} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.create).toHaveBeenCalledWith({
      orgId: "org-1",
      agentId: "agent-1",
      sessionId: "terminal-1",
      cols: 80,
      rows: 24,
    });
    expect(mocks.write).toHaveBeenCalledWith("existing output\r\n");
    expect(mocks.focus).toHaveBeenCalled();
    expect(container.textContent).not.toContain("Starting terminal");

    act(() => {
      mocks.outputListener?.({ sessionId: "other", data: "ignored" });
      mocks.outputListener?.({ sessionId: "terminal-1", data: "next output" });
      mocks.onData?.("pwd\r");
      mocks.onResize?.({ cols: 100, rows: 30 });
    });
    expect(mocks.write).not.toHaveBeenCalledWith("ignored");
    expect(mocks.write).toHaveBeenCalledWith("next output");
    expect(mocks.input).toHaveBeenCalledWith("terminal-1", "pwd\r");
    expect(mocks.resize).toHaveBeenCalledWith("terminal-1", 100, 30);
  });

  it("shows a recoverable failure and restarts the same session", async () => {
    mocks.create.mockRejectedValueOnce(new Error(
      "Error invoking remote method 'desktop:terminal:create': Error: The Agent workspace is unavailable on this machine.",
    ));
    await act(async () => {
      root.render(<TerminalPanelView active target={target} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Terminal unavailable");
    expect(container.textContent).toContain("Agent workspace is unavailable");
    expect(container.textContent).not.toContain("Error invoking remote method");

    mocks.create.mockResolvedValueOnce({ sessionId: "terminal-1", replay: "", status: "running" });
    const restart = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Restart terminal"));
    await act(async () => {
      restart?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.create).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain("Terminal unavailable");
  });

  it("normalizes Desktop transport errors without hiding the actionable cause", () => {
    expect(terminalErrorMessage(new Error(
      "Error invoking remote method 'desktop:terminal:create': Error: The native Terminal host is unavailable.",
    ))).toBe("The native Terminal host is unavailable.");
    expect(terminalErrorMessage("unknown failure")).toBe("Terminal failed to start.");
  });

  it("does not restart an exited shell until the user requests it", async () => {
    await act(async () => {
      root.render(<TerminalPanelView active target={target} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.create).toHaveBeenCalledTimes(1);

    act(() => {
      mocks.exitListener?.({ sessionId: "terminal-1", code: 0, signal: null, error: null });
      mocks.resizeObserverCallback?.([], {} as ResizeObserver);
    });
    expect(container.textContent).toContain("Shell exited");
    expect(mocks.create).toHaveBeenCalledTimes(1);

    const restart = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Restart terminal"));
    await act(async () => {
      restart?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.create).toHaveBeenCalledTimes(2);
  });

  it("does not ask Desktop to start without an Agent", async () => {
    await act(async () => {
      root.render(<TerminalPanelView active target={{ ...target, agentId: null }} />);
      await Promise.resolve();
    });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Select an Agent for this Chat");
  });

  it("waits for a usable visible layout before creating the PTY", async () => {
    mocks.proposedDimensions = { cols: 2, rows: 1 };
    await act(async () => {
      root.render(<TerminalPanelView active target={target} />);
      await Promise.resolve();
    });
    expect(mocks.create).not.toHaveBeenCalled();

    mocks.proposedDimensions = { cols: 96, rows: 30 };
    await act(async () => {
      mocks.resizeObserverCallback?.([], {} as ResizeObserver);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ cols: 80, rows: 24 }));
  });
});
