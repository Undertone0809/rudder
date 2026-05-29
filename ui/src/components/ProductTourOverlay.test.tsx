// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProductTourOverlay, hasCompletedProductTour } from "./ProductTourOverlay";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const closeProductTour = vi.hoisted(() => vi.fn());
const navigate = vi.hoisted(() => vi.fn());
let storageState: Record<string, string> = {};

function installLocalStorageMock() {
  storageState = {};
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => storageState[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      storageState[key] = String(value);
    }),
    removeItem: vi.fn((key: string) => {
      delete storageState[key];
    }),
    clear: vi.fn(() => {
      storageState = {};
    }),
  });
}

vi.mock("@/context/DialogContext", () => ({
  useDialog: () => ({
    productTourOpen: true,
    closeProductTour,
  }),
}));

vi.mock("@/context/I18nContext", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) => {
      const messages: Record<string, string> = {
        "productTour.checklist.title": "Complete your first work loop",
        "productTour.checklist.workspace": "Read the control plane",
        "productTour.checklist.create": "Create a small task",
        "productTour.checklist.issues": "Track issue state",
        "productTour.checklist.inspect": "Inspect work output",
        "productTour.checklist.settings": "Find the tour again",
        "productTour.stepCounter": "{{current}} / {{total}}",
        "productTour.step.workspace.title": "Rudder is the control plane for agent work",
        "productTour.step.workspace.body": "The rail keeps the main work surfaces close.",
        "productTour.step.create.title": "Start with one task an agent can actually move",
        "productTour.step.create.body": "The create menu is where new work begins.",
        "productTour.step.issues.title": "Issues are the executable units of work",
        "productTour.step.issues.body": "The Issue surface shows work state.",
        "productTour.step.inspect.title": "Inspect the work before you approve or continue",
        "productTour.step.inspect.body": "The Dashboard shows details and outputs.",
        "productTour.step.settings.title": "You can replay this tour from Settings",
        "productTour.step.settings.body": "Open System settings, then General.",
        "productTour.back": "Back",
        "productTour.next": "Next",
        "productTour.finish": "Finish",
        "productTour.skip": "Skip tour",
      };
      return (messages[key] ?? key).replaceAll(/\{\{(\w+)\}\}/g, (_match, name: string) =>
        String(params?.[name] ?? _match),
      );
    },
  }),
}));

vi.mock("@/lib/router", () => ({
  useNavigate: () => navigate,
}));

let cleanupFn: (() => void) | null = null;

afterEach(() => {
  cleanupFn?.();
  cleanupFn = null;
  document.body.innerHTML = "";
  document.documentElement.classList.remove("desktop-shell-macos");
  window.localStorage.clear();
  closeProductTour.mockReset();
  navigate.mockReset();
  vi.unstubAllGlobals();
});

function click(element: Element) {
  (element as HTMLElement).click();
}

function setViewport(width: number, height: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
}

function renderOverlay(targetRect?: Partial<DOMRect>, options?: { compactRailSpotlight?: boolean }) {
  installLocalStorageMock();

  const target = document.createElement("button");
  target.dataset.tourTarget = "primary-rail";
  if (options?.compactRailSpotlight) {
    target.dataset.tourSpotlight = "compact-rail";
  }
  target.getBoundingClientRect = vi.fn(() => ({
    x: targetRect?.x ?? targetRect?.left ?? 8,
    y: targetRect?.y ?? targetRect?.top ?? 36,
    left: targetRect?.left ?? 8,
    top: targetRect?.top ?? 36,
    right: targetRect?.right ?? 76,
    bottom: targetRect?.bottom ?? 720,
    width: targetRect?.width ?? 68,
    height: targetRect?.height ?? 684,
    toJSON: () => ({}),
  }));
  document.body.appendChild(target);

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  cleanupFn = () => {
    act(() => {
      root.unmount();
    });
    container.remove();
  };

  act(() => {
    root.render(<ProductTourOverlay />);
  });

  return container;
}

describe("ProductTourOverlay", () => {
  it("steps through the guided tour and marks it complete on finish", async () => {
    setViewport(1280, 800);
    const container = renderOverlay();

    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Rudder is the control plane for agent work");
    expect(container.textContent).toContain("1 / 5");

    for (let index = 0; index < 4; index += 1) {
      const nextButton = Array.from(document.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("Next"));
      expect(nextButton).toBeTruthy();
      act(() => {
        click(nextButton!);
      });
    }

    expect(container.textContent).toContain("You can replay this tour from Settings");

    const finishButton = Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Finish"));
    expect(finishButton).toBeTruthy();

    act(() => {
      click(finishButton!);
    });

    expect(closeProductTour).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith("/issues");
    expect(hasCompletedProductTour()).toBe(true);
  });

  it("opens the issue tracker when the issue step becomes active", async () => {
    setViewport(1280, 800);
    renderOverlay();

    await act(async () => {
      await Promise.resolve();
    });

    for (let index = 0; index < 2; index += 1) {
      const nextButton = Array.from(document.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("Next"));
      expect(nextButton).toBeTruthy();
      act(() => {
        click(nextButton!);
      });
    }

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith("/issues");
  });

  it("clears pending setup tour state without reopening issues after the issue step already opened it", async () => {
    setViewport(1280, 800);
    const container = renderOverlay();
    window.localStorage.setItem("rudder.productTour.pendingAfterSetup.v1", "true");

    await act(async () => {
      await Promise.resolve();
    });

    for (let index = 0; index < 4; index += 1) {
      const nextButton = Array.from(document.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("Next"));
      expect(nextButton).toBeTruthy();
      act(() => {
        click(nextButton!);
      });
    }

    expect(container.textContent).toContain("You can replay this tour from Settings");

    const finishButton = Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Finish"));
    expect(finishButton).toBeTruthy();

    act(() => {
      click(finishButton!);
    });

    expect(closeProductTour).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith("/issues");
    expect(hasCompletedProductTour()).toBe(true);
    expect(window.localStorage.getItem("rudder.productTour.pendingAfterSetup.v1")).toBeNull();
  });

  it("keeps desktop tour chrome out of the macOS titlebar and rail area", async () => {
    setViewport(1440, 900);
    document.documentElement.classList.add("desktop-shell-macos");
    const container = renderOverlay({ left: 8, top: 36, width: 68, height: 820, right: 76, bottom: 856 });

    await act(async () => {
      await Promise.resolve();
    });

    const checklist = container.querySelector("aside") as HTMLElement | null;
    const callout = container.querySelector("section") as HTMLElement | null;

    expect(checklist?.style.top).toBe("48px");
    expect(checklist?.style.right).toBe("16px");
    expect(checklist?.style.left).toBe("");
    expect(callout?.style.left).toBe("104px");
    expect(callout?.style.top).toBe("48px");
  });

  it("keeps the web checklist from covering the first tour callout", async () => {
    setViewport(1920, 1257);
    const container = renderOverlay({ left: 0, top: 76, width: 88, height: 1170, right: 88, bottom: 1246 });

    await act(async () => {
      await Promise.resolve();
    });

    const checklist = container.querySelector("[data-testid='product-tour-checklist']") as HTMLElement | null;
    const callout = container.querySelector("[data-testid='product-tour-callout']") as HTMLElement | null;

    expect(checklist?.style.left).toBe("1684px");
    expect(checklist?.style.top).toBe("20px");
    expect(callout?.style.left).toBe("124px");
  });

  it("uses a narrower spotlight for compact rail navigation targets", async () => {
    setViewport(1440, 900);
    renderOverlay({ left: 23, top: 300, width: 66, height: 56, right: 89, bottom: 356 }, { compactRailSpotlight: true });

    await act(async () => {
      await Promise.resolve();
    });

    const spotlight = document.querySelector("[aria-hidden='true']") as HTMLElement | null;

    expect(spotlight?.style.left).toBe("26px");
    expect(spotlight?.style.width).toBe("60px");
  });
});
