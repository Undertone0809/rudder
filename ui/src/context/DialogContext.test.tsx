// @vitest-environment jsdom

import { act, createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DialogProvider, useDialog } from "./DialogContext";

type MockDialogContextValue = {
  open: boolean;
  finishClose: () => void;
  registerCloseAutoFocus: (callback: ((event: Event) => void) | null) => void;
};

const MockDialogContext = createContext<MockDialogContextValue>({
  open: false,
  finishClose: () => undefined,
  registerCloseAutoFocus: () => undefined,
});

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({
    children,
    open,
    onOpenChange,
  }: {
    children: ReactNode;
    open: boolean;
    onOpenChange?: (open: boolean) => void;
  }) => {
    const [present, setPresent] = useState(open);
    const closeAutoFocusRef = useRef<((event: Event) => void) | null>(null);

    useEffect(() => {
      if (open) setPresent(true);
    }, [open]);

    useEffect(() => {
      if (!open || !present) return;
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape") onOpenChange?.(false);
      };
      document.addEventListener("keydown", onKeyDown);
      return () => document.removeEventListener("keydown", onKeyDown);
    }, [onOpenChange, open, present]);

    if (!present) return null;
    return (
      <MockDialogContext.Provider
        value={{
          open,
          registerCloseAutoFocus: (callback) => {
            closeAutoFocusRef.current = callback;
          },
          finishClose: () => {
            closeAutoFocusRef.current?.(new Event("closeAutoFocus", { cancelable: true }));
            setPresent(false);
          },
        }}
      >
        <div data-testid="mock-dialog-root" onClick={() => onOpenChange?.(false)}>
          {children}
        </div>
      </MockDialogContext.Provider>
    );
  },
  DialogContent: ({
    children,
    onCloseAutoFocus,
  }: {
    children: ReactNode;
    onCloseAutoFocus?: (event: Event) => void;
  }) => {
    const context = useContext(MockDialogContext);
    useEffect(() => {
      context.registerCloseAutoFocus(onCloseAutoFocus ?? null);
      return () => context.registerCloseAutoFocus(null);
    }, [context, onCloseAutoFocus]);
    return (
      <div
        role="dialog"
        data-state={context.open ? "open" : "closed"}
        onClick={(event) => event.stopPropagation()}
      >
        {children}
        {!context.open ? (
          <button
            type="button"
            data-testid="finish-dialog-exit"
            onClick={context.finishClose}
          >
            Finish exit
          </button>
        ) : null}
      </div>
    );
  },
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

function Harness() {
  const { confirm, promptText } = useDialog();
  const [result, setResult] = useState("idle");

  return (
    <>
      <button
        type="button"
        onClick={() => {
          void confirm({
            title: "Separate items",
            description: 'Move the items in "feat" back into the main list?',
            confirmLabel: "Separate items",
          }).then((confirmed) => setResult(String(confirmed)));
        }}
      >
        Open confirm
      </button>
      <button
        type="button"
        onClick={() => {
          void promptText({
            title: "Rename group",
            defaultValue: "feat",
            confirmLabel: "Rename",
          }).then((value) => setResult(value ?? "cancelled"));
        }}
      >
        Open prompt
      </button>
      <output>{result}</output>
    </>
  );
}

function renderHarness() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <DialogProvider>
        <Harness />
      </DialogProvider>,
    );
  });
  return container;
}

function button(name: string) {
  return Array.from(document.body.querySelectorAll("button"))
    .find((candidate) => candidate.textContent === name) as HTMLButtonElement | undefined;
}

function finishExitAnimation() {
  act(() => {
    document.body.querySelector<HTMLButtonElement>('[data-testid="finish-dialog-exit"]')?.click();
  });
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

describe("DialogProvider", () => {
  it("retains confirmation content until its exit animation completes", async () => {
    const container = renderHarness();
    const trigger = button("Open confirm");
    trigger?.focus();

    act(() => trigger?.click());
    expect(document.body.textContent).toContain("Separate items");
    expect(document.body.textContent).toContain('Move the items in "feat" back into the main list?');

    await act(async () => {
      button("Separate items")?.click();
      await Promise.resolve();
    });

    const closingDialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    expect(closingDialog?.dataset.state).toBe("closed");
    expect(closingDialog?.textContent).toContain("Separate items");
    expect(closingDialog?.textContent).toContain('Move the items in "feat" back into the main list?');
    expect(closingDialog?.textContent).not.toContain("Confirm");
    expect(container.querySelector("output")?.textContent).toBe("true");

    finishExitAnimation();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("dismisses once and reopens with a fresh request", async () => {
    const container = renderHarness();
    const trigger = button("Open confirm");
    act(() => trigger?.click());

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await Promise.resolve();
    });

    const closingDialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    expect(closingDialog?.textContent).toContain("Separate items");
    expect(container.querySelector("output")?.textContent).toBe("false");
    finishExitAnimation();

    act(() => button("Open prompt")?.click());
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain("Rename group");
    expect((document.body.querySelector("input") as HTMLInputElement | null)?.value).toBe("feat");

    await act(async () => {
      button("Rename")?.click();
      button("Rename")?.click();
      await Promise.resolve();
    });
    expect(container.querySelector("output")?.textContent).toBe("feat");
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain("Rename group");
    finishExitAnimation();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it("does not let an older close cleanup clear a newer request", async () => {
    renderHarness();
    act(() => button("Open confirm")?.click());
    await act(async () => {
      button("Cancel")?.click();
      await Promise.resolve();
    });
    expect(document.body.querySelector<HTMLElement>('[role="dialog"]')?.dataset.state).toBe("closed");

    act(() => button("Open prompt")?.click());
    const openDialog = Array.from(document.body.querySelectorAll<HTMLElement>('[role="dialog"]'))
      .find((dialog) => dialog.dataset.state === "open");
    expect(openDialog?.textContent).toContain("Rename group");

    finishExitAnimation();
    const remainingDialog = Array.from(document.body.querySelectorAll<HTMLElement>('[role="dialog"]'))
      .find((dialog) => dialog.dataset.state === "open");
    expect(remainingDialog?.textContent).toContain("Rename group");
    expect(button("Rename")).toBeDefined();
  });
});
