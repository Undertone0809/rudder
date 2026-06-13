// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { CSSProperties, KeyboardEventHandler, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "./CommandPalette";
import { getKeyboardShortcutPlatform } from "@/lib/keyboard-shortcuts";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const navigateMock = vi.fn();
const observedQueryKeys = vi.hoisted(() => [] as Array<readonly unknown[]>);
const queryDataByKey = vi.hoisted(() => new Map<string, unknown>());
const shortcutSettingsMock = vi.hoisted(() => ({
  value: null as null | {
    shortcuts: Array<{
      actionId: "commandPalette.open";
      bindings?: Array<{ key: string; metaKey?: boolean; ctrlKey?: boolean }>;
      disabled?: boolean;
    }>;
  },
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey, enabled }: { queryKey: readonly unknown[]; enabled?: boolean }) => {
    observedQueryKeys.push(queryKey);
    const queryData = queryDataByKey.get(JSON.stringify(queryKey));
    if (queryData !== undefined) return { data: queryData };
    if (enabled === false) return { data: [] };
    if (
      queryKey[0] === "issues" &&
      queryKey[2] === "search" &&
      (queryKey[3] === "launch" || queryKey[3] === "status icon") &&
      queryKey[5] === "title,description,comment"
    ) {
      return {
        data: [
          {
            id: "issue-1",
            identifier: "RUD-498",
            title: "Global search regression",
            status: "todo",
            assigneeAgentId: null,
          },
        ],
      };
    }
    if (
      queryKey[0] === "organizations" &&
      queryKey[2] === "workspace-mention-files" &&
      queryKey[3] === "onboarding"
    ) {
      return {
        data: {
          entries: [
            {
              name: "onboarding.md",
              path: "docs/onboarding.md",
              isDirectory: false,
            },
          ],
        },
      };
    }
    if (queryKey[0] === "organizations" && queryKey[2] === "workspace-mention-files") {
      return { data: { entries: [] } };
    }
    if (queryKey[0] === "chats" && queryKey[3] === "search" && queryKey[4] === "launch") {
      return {
        data: [
          {
            id: "chat-1",
            title: "Launch planning",
            status: "active",
            summary: null,
            latestReplyPreview: "Latest assistant reply",
            latestUserMessagePreview: null,
            userMessageCount: 0,
            searchPreview: "Message body matched launch planning notes.",
          },
        ],
      };
    }
    if (queryKey[0] === "agents") return { data: [] };
    if (queryKey[0] === "projects") return { data: [] };
    if (queryKey[0] === "issues") return { data: [] };
    if (queryKey[0] === "instance" && queryKey[1] === "shortcut-settings") {
      return { data: shortcutSettingsMock.value };
    }
    return { data: [] };
  },
}));

vi.mock("../context/OrganizationContext", () => ({
  useOrganization: () => ({
    selectedOrganizationId: "org-1",
    selectedOrganization: { issuePrefix: "RUD" },
  }),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({
    isMobile: false,
    setSidebarOpen: vi.fn(),
  }),
}));

vi.mock("@/lib/router", () => ({
  useNavigate: () => navigateMock,
}));

vi.mock("./AgentAvatar", () => ({
  AgentIdentity: ({ name }: { name: string }) => <span>{name}</span>,
}));

vi.mock("@/components/ui/command", () => ({
  CommandDialog: ({
    open,
    children,
    contentStyle,
  }: {
    open: boolean;
    children: ReactNode;
    contentStyle?: CSSProperties;
  }) =>
    open ? (
      <div role="dialog" style={contentStyle}>
        {children}
      </div>
    ) : null,
  CommandInput: ({
    placeholder,
    value,
    onValueChange,
    onKeyDown,
    inputPrefix,
  }: {
    placeholder?: string;
    value?: string;
    onValueChange?: (value: string) => void;
    onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
    inputPrefix?: ReactNode;
  }) => (
    <>
      {inputPrefix}
      <input
        aria-label="Command input"
        placeholder={placeholder}
        value={value}
        onChange={(event) => onValueChange?.(event.currentTarget.value)}
        onKeyDown={onKeyDown}
      />
      <button type="button" aria-label="Search launch" onClick={() => onValueChange?.("launch")} />
    </>
  ),
  CommandList: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CommandEmpty: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CommandGroup: ({ heading, children }: { heading: string; children: ReactNode }) => (
    <section aria-label={heading}>
      <h2>{heading}</h2>
      {children}
    </section>
  ),
  CommandItem: ({
    children,
    onSelect,
    value,
  }: {
    children: ReactNode;
    onSelect?: () => void;
    value?: string;
  }) => <button type="button" data-value={value} onClick={onSelect}>{children}</button>,
  CommandSeparator: () => <hr />,
}));

let cleanupFn: (() => void) | null = null;

afterEach(() => {
  cleanupFn?.();
  cleanupFn = null;
  observedQueryKeys.length = 0;
  queryDataByKey.clear();
  shortcutSettingsMock.value = null;
  navigateMock.mockClear();
  document.body.innerHTML = "";
});

function renderCommandPalette() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  cleanupFn = () => {
    act(() => root.unmount());
    container.remove();
  };

  act(() => {
    root.render(<CommandPalette />);
  });
  return container;
}

function openCommandPalette(container: HTMLElement) {
  act(() => {
    document.dispatchEvent(createDefaultCommandPaletteShortcutEvent());
  });
  const input = container.querySelector<HTMLInputElement>("input");
  expect(input).not.toBeNull();
  return input!;
}

function createDefaultCommandPaletteShortcutEvent(targetKey = "k") {
  const modifier = getKeyboardShortcutPlatform() === "mac"
    ? { metaKey: true }
    : { ctrlKey: true };
  return new KeyboardEvent("keydown", { key: targetKey, ...modifier, bubbles: true });
}

function changeInput(input: HTMLInputElement, value: string) {
  act(() => {
    const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    valueSetter?.call(input, value);
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
  });
}

describe("CommandPalette", () => {
  it("opens from the primary rail search event", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    cleanupFn = () => {
      act(() => root.unmount());
      container.remove();
    };

    act(() => {
      root.render(<CommandPalette />);
    });
    act(() => {
      document.dispatchEvent(new CustomEvent("rudder:open-command-palette", {
        detail: { source: "primary-rail" },
      }));
    });

    const input = container.querySelector("input");
    expect(input?.getAttribute("placeholder")).toBe("Search issues, chats, agents, projects, library...");

    const dialog = container.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.style.left).toBe("50vw");
    expect(dialog?.style.top).toBe("50vh");
  });

  it("shows chat search results and navigates to the selected conversation", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    cleanupFn = () => {
      act(() => root.unmount());
      container.remove();
    };

    act(() => {
      root.render(<CommandPalette />);
    });
    act(() => {
      document.dispatchEvent(createDefaultCommandPaletteShortcutEvent());
    });

    const input = container.querySelector("input");
    expect(input?.getAttribute("placeholder")).toBe("Search issues, chats, agents, projects, library...");

    const searchLaunch = container.querySelector('button[aria-label="Search launch"]');
    act(() => {
      searchLaunch?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("Chats");
    expect(container.textContent).toContain("Launch planning");
    expect(container.textContent).toContain("Message body matched launch planning notes.");

    const chatButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Launch planning"));
    act(() => {
      chatButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(navigateMock).toHaveBeenCalledWith("/messenger/chat/chat-1");
  });

  it("searches issue titles, descriptions, and comments from the global command palette", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    cleanupFn = () => {
      act(() => root.unmount());
      container.remove();
    };

    act(() => {
      root.render(<CommandPalette />);
    });
    act(() => {
      document.dispatchEvent(createDefaultCommandPaletteShortcutEvent());
    });

    const searchLaunch = container.querySelector('button[aria-label="Search launch"]');
    act(() => {
      searchLaunch?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(observedQueryKeys).toContainEqual([
      "issues",
      "org-1",
      "search",
      "launch",
      "__all-projects__",
      "title,description,comment",
    ]);
    expect(container.textContent).toContain("Issues");
    expect(container.textContent).toContain("RUD-498");
    expect(container.textContent).toContain("Global search regression");
  });

  it("opens from the configured command palette shortcut", () => {
    shortcutSettingsMock.value = {
      shortcuts: [
        {
          actionId: "commandPalette.open",
          bindings: [{ key: "p", metaKey: true }],
        },
      ],
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    cleanupFn = () => {
      act(() => root.unmount());
      container.remove();
    };

    act(() => {
      root.render(<CommandPalette />);
    });
    act(() => {
      document.dispatchEvent(createDefaultCommandPaletteShortcutEvent());
    });
    expect(container.querySelector("input")).toBeNull();

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "p", metaKey: true, bubbles: true }));
    });
    expect(container.querySelector("input")?.getAttribute("placeholder")).toBe("Search issues, chats, agents, projects, library...");
  });

  it("does not open from editable targets", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const input = document.createElement("input");
    document.body.appendChild(input);
    const root = createRoot(container);
    cleanupFn = () => {
      act(() => root.unmount());
      container.remove();
      input.remove();
    };

    act(() => {
      root.render(<CommandPalette />);
    });
    act(() => {
      input.dispatchEvent(createDefaultCommandPaletteShortcutEvent());
    });

    expect(container.querySelector("input")).toBeNull();
  });

  it("confirms an issue scope and only renders issue search results", () => {
    const container = renderCommandPalette();
    const input = openCommandPalette(container);

    changeInput(input, "issue ");
    expect(container.querySelector("input")?.getAttribute("placeholder")).toBe("Search Issues...");
    expect(container.textContent).toContain("Issues");

    const scopedInput = container.querySelector<HTMLInputElement>("input");
    expect(scopedInput).not.toBeNull();
    changeInput(scopedInput!, "status icon");

    expect(container.textContent).toContain("Global search regression");
    expect(container.textContent).not.toContain("Launch planning");
    expect(observedQueryKeys).toContainEqual([
      "issues",
      "org-1",
      "search",
      "status icon",
      "__all-projects__",
      "title,description,comment",
    ]);
  });

  it("shows a pending scope suggestion without entering scoped mode", () => {
    const container = renderCommandPalette();
    const input = openCommandPalette(container);

    changeInput(input, "iss");

    expect(container.querySelector("input")?.getAttribute("placeholder")).toBe("Search issues, chats, agents, projects, library...");
    expect(container.textContent).toContain("Search in Issues");
    expect(container.querySelector('[aria-label="Clear Issues search scope"]')).toBeNull();
  });

  it("searches Library only after a library scope has query text", () => {
    const container = renderCommandPalette();
    const input = openCommandPalette(container);

    changeInput(input, "library ");

    expect(container.querySelector("input")?.getAttribute("placeholder")).toBe("Search Library...");
    expect(container.textContent).toContain("Type to search Library");
    expect(observedQueryKeys).toContainEqual([
      "organizations",
      "org-1",
      "workspace-mention-files",
      "",
    ]);

    const scopedInput = container.querySelector<HTMLInputElement>("input");
    expect(scopedInput).not.toBeNull();
    changeInput(scopedInput!, "onboarding");

    expect(container.textContent).toContain("Library");
    expect(container.textContent).toContain("onboarding.md");
    expect(container.textContent).toContain("docs/onboarding.md");
    expect(container.textContent).not.toContain("Issues");

    const resultButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("onboarding.md"));
    act(() => {
      resultButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(navigateMock).toHaveBeenCalledWith("/library?path=docs%2Fonboarding.md");
  });

  it("does not render cached empty-query Library entries while waiting for scoped query text", () => {
    queryDataByKey.set(JSON.stringify([
      "organizations",
      "org-1",
      "workspace-mention-files",
      "",
    ]), {
      entries: [
        {
          name: "review-scoped-file.md",
          path: "docs/review-scoped-file.md",
          isDirectory: false,
        },
        {
          name: "review-scoped-dir",
          path: "docs/review-scoped-dir",
          isDirectory: true,
        },
      ],
    });
    const container = renderCommandPalette();
    const input = openCommandPalette(container);

    changeInput(input, "library ");

    expect(container.querySelector("input")?.getAttribute("placeholder")).toBe("Search Library...");
    expect(container.textContent).toContain("Type to search Library");
    expect(container.textContent).not.toContain("review-scoped-file.md");
    expect(container.textContent).not.toContain("review-scoped-dir");
  });

  it("exits scoped mode from Backspace or the chip clear button", () => {
    const container = renderCommandPalette();
    const input = openCommandPalette(container);

    changeInput(input, "issue ");
    expect(container.querySelector("input")?.getAttribute("placeholder")).toBe("Search Issues...");

    const scopedInput = container.querySelector<HTMLInputElement>("input");
    expect(scopedInput).not.toBeNull();
    act(() => {
      scopedInput!.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
    });
    expect(container.querySelector("input")?.getAttribute("placeholder")).toBe("Search issues, chats, agents, projects, library...");

    changeInput(container.querySelector<HTMLInputElement>("input")!, "library ");
    const clearButton = container.querySelector<HTMLButtonElement>('[aria-label="Clear Library search scope"]');
    expect(clearButton).not.toBeNull();
    act(() => {
      clearButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector("input")?.getAttribute("placeholder")).toBe("Search issues, chats, agents, projects, library...");
  });
});
