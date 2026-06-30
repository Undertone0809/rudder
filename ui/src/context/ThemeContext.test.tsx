// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider, useTheme } from "./ThemeContext";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type MatchMediaListener = ((event: MediaQueryListEvent) => void) | null;
type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  clear(): void;
};

function installLocalStorage() {
  const storage = new Map<string, string>();
  const localStorageStub: StorageLike = {
    getItem(key: string) {
      return storage.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      storage.set(key, value);
    },
    clear() {
      storage.clear();
    },
  };
  Object.defineProperty(window, "localStorage", {
    value: localStorageStub,
    configurable: true,
  });
  return localStorageStub;
}

function installMatchMedia(initialDark: boolean) {
  let matches = initialDark;
  let listener: MatchMediaListener = null;
  const matchMedia = vi.fn().mockImplementation(() => ({
    matches,
    media: "(prefers-color-scheme: dark)",
    addEventListener: (_event: string, nextListener: MatchMediaListener) => {
      listener = nextListener;
    },
    removeEventListener: () => {
      listener = null;
    },
  }));
  Object.defineProperty(window, "matchMedia", {
    value: matchMedia,
    configurable: true,
    writable: true,
  });
  return {
    setMatches(nextMatches: boolean) {
      matches = nextMatches;
      listener?.({ matches } as MediaQueryListEvent);
    },
  };
}

function ThemeProbe() {
  const {
    theme,
    resolvedTheme,
    designStyle,
    baseColor,
    accentTheme,
    setTheme,
    setDesignStyle,
    setBaseColor,
    setAccentTheme,
  } = useTheme();
  return (
    <div>
      <button type="button" onClick={() => setTheme("light")}>Light</button>
      <button type="button" onClick={() => setTheme("system")}>System</button>
      <button type="button" onClick={() => setDesignStyle("mira")}>Mira</button>
      <button type="button" onClick={() => setBaseColor("taupe")}>Taupe</button>
      <button type="button" onClick={() => setAccentTheme("pink")}>Pink</button>
      <span data-testid="theme">{theme}</span>
      <span data-testid="resolved">{resolvedTheme}</span>
      <span data-testid="design-style">{designStyle}</span>
      <span data-testid="base-color">{baseColor}</span>
      <span data-testid="accent-theme">{accentTheme}</span>
    </div>
  );
}

let cleanupFn: (() => void) | null = null;

beforeEach(() => {
  installLocalStorage().clear();
  document.documentElement.className = "";
  document.documentElement.removeAttribute("style");
  delete document.documentElement.dataset.style;
  delete document.documentElement.dataset.baseColor;
  delete document.documentElement.dataset.themeColor;
});

afterEach(() => {
  cleanupFn?.();
  cleanupFn = null;
  vi.restoreAllMocks();
});

function renderThemeProvider() {
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
    root.render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>,
    );
  });

  return container;
}

describe("ThemeProvider desktop shell bridge", () => {
  it("uses Luma as the design style when no stored preference exists", () => {
    installMatchMedia(true);

    const container = renderThemeProvider();

    expect(container.querySelector("[data-testid='design-style']")?.textContent).toBe("luma");
    expect(document.documentElement.dataset.style).toBe("luma");
    expect(localStorage.getItem("rudder.designStyle")).toBe("luma");
  });

  it("falls back to Luma when the stored design style is unsupported", () => {
    installMatchMedia(true);
    localStorage.setItem("rudder.designStyle", "unsupported");

    const container = renderThemeProvider();

    expect(container.querySelector("[data-testid='design-style']")?.textContent).toBe("luma");
    expect(document.documentElement.dataset.style).toBe("luma");
    expect(localStorage.getItem("rudder.designStyle")).toBe("luma");
  });

  it("passes the stored light preference to the desktop shell even when the system is dark", () => {
    installMatchMedia(true);
    localStorage.setItem("rudder.theme", "light");
    const setAppearance = vi.fn();
    Object.defineProperty(window, "desktopShell", {
      value: { setAppearance },
      configurable: true,
    });

    renderThemeProvider();

    expect(setAppearance).toHaveBeenCalledWith("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("keeps the desktop shell on system mode and reacts to system appearance changes", () => {
    const media = installMatchMedia(false);
    localStorage.setItem("rudder.theme", "system");
    const setAppearance = vi.fn();
    Object.defineProperty(window, "desktopShell", {
      value: { setAppearance },
      configurable: true,
    });

    renderThemeProvider();

    expect(setAppearance).toHaveBeenCalledWith("system");

    act(() => {
      media.setMatches(true);
    });

    expect(setAppearance).toHaveBeenLastCalledWith("system");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("applies and persists the selected appearance choices on the root element", () => {
    installMatchMedia(true);
    localStorage.setItem("rudder.theme", "dark");
    localStorage.setItem("rudder.designStyle", "luma");
    localStorage.setItem("rudder.baseColor", "taupe");
    localStorage.setItem("rudder.accentTheme", "pink");

    const container = renderThemeProvider();

    expect(container.querySelector("[data-testid='design-style']")?.textContent).toBe("luma");
    expect(container.querySelector("[data-testid='base-color']")?.textContent).toBe("taupe");
    expect(container.querySelector("[data-testid='accent-theme']")?.textContent).toBe("pink");
    expect(document.documentElement.dataset.style).toBe("luma");
    expect(document.documentElement.dataset.baseColor).toBe("taupe");
    expect(document.documentElement.dataset.themeColor).toBe("pink");

    const miraButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Mira");
    const taupeButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Taupe");
    const pinkButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Pink");
    act(() => {
      miraButton?.click();
      taupeButton?.click();
      pinkButton?.click();
    });

    expect(document.documentElement.dataset.style).toBe("mira");
    expect(document.documentElement.dataset.baseColor).toBe("taupe");
    expect(document.documentElement.dataset.themeColor).toBe("pink");
    expect(localStorage.getItem("rudder.designStyle")).toBe("mira");
    expect(localStorage.getItem("rudder.baseColor")).toBe("taupe");
    expect(localStorage.getItem("rudder.accentTheme")).toBe("pink");
  });
});
