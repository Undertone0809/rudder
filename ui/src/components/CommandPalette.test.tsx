// @vitest-environment jsdom

import { ActivityCoordinatorScope } from "@/context/ActivityCoordinatorContext";
import { getKeyboardShortcutPlatform } from "@/lib/keyboard-shortcuts";
import { ActivityCoordinator } from "@/runtime/activity-coordinator";
import type { CSSProperties, KeyboardEventHandler, ReactNode } from "react";
import { act, Profiler } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "./CommandPalette";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const navigateMock = vi.fn();
const observedQueryKeys = vi.hoisted(() => [] as Array<readonly unknown[]>);
const queryDataByKey = vi.hoisted(() => new Map<string, unknown>());
const queryStateByKey = vi.hoisted(() => new Map<string, {
  data?: unknown;
  isFetching?: boolean;
  isLoading?: boolean;
}>());
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
    const queryState = queryStateByKey.get(JSON.stringify(queryKey));
    if (queryState !== undefined) return queryState;
    const queryData = queryDataByKey.get(JSON.stringify(queryKey));
    if (queryData !== undefined) return { data: queryData };
    if (enabled === false) return { data: [] };
    if (
      queryKey[0] === "issues" &&
      queryKey[2] === "command-palette" &&
      queryKey[3] === "search" &&
      (queryKey[4] === "launch" || queryKey[4] === "status icon") &&
      queryKey[5] === "title,description,comment" &&
      queryKey[6] === 20
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
    if (
      queryKey[0] === "chats" &&
      queryKey[2] === "command-palette" &&
      queryKey[3] === "search" &&
      queryKey[5] === "launch" &&
      queryKey[6] === 20
    ) {
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
            lastMessageAt: new Date("2026-06-09T11:40:00.000Z"),
            updatedAt: new Date("2026-06-09T11:40:00.000Z"),
          },
        ],
      };
    }
    if (queryKey[0] === "agents") return { data: [] };
    if (queryKey[0] === "projects") return { data: [] };
    if (queryKey[0] === "organization-skills") {
      return {
        data: [
          {
            id: "skill-router",
            orgId: "org-1",
            key: "agent:development-lifecycle-router-maintainer",
            slug: "development-lifecycle-router-maintainer",
            name: "development-lifecycle-router-maintainer",
            description: "Route Rudder development work through lifecycle stages.",
            sourceType: "local_path",
            sourceLocator: "/workspace/.agents/skills/maintainer/development-lifecycle-router-maintainer",
            sourceRef: null,
            trustLevel: "markdown_only",
            compatibility: "compatible",
            fileInventory: [{ path: "SKILL.md", kind: "skill" }],
            createdAt: new Date(),
            updatedAt: new Date(),
            attachedAgentCount: 0,
            editable: true,
            editableReason: null,
            sourceLabel: "Maintainer",
            sourceBadge: "local",
            sourcePath: "/workspace/.agents/skills/maintainer/development-lifecycle-router-maintainer/SKILL.md",
            workspaceEditPath: null,
          },
        ],
      };
    }
    if (queryKey[0] === "issues" && queryKey[2] === "command-palette" && queryKey[3] === "list") return { data: [] };
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
    className,
    contentStyle,
  }: {
    open: boolean;
    children: ReactNode;
    className?: string;
    contentStyle?: CSSProperties;
  }) =>
    open ? (
      <div role="dialog" className={className} style={contentStyle}>
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

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-09T12:00:00.000Z"));
});

afterEach(() => {
  cleanupFn?.();
  cleanupFn = null;
  observedQueryKeys.length = 0;
  queryDataByKey.clear();
  queryStateByKey.clear();
  shortcutSettingsMock.value = null;
  navigateMock.mockClear();
  document.body.innerHTML = "";
  vi.useRealTimers();
});

function renderCommandPalette({
  coordinator,
  onRender,
}: {
  coordinator?: ActivityCoordinator;
  onRender?: () => void;
} = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  cleanupFn = () => {
    act(() => root.unmount());
    container.remove();
  };

  act(() => {
    const palette = (
      <Profiler id="command-palette" onRender={() => onRender?.()}>
        <CommandPalette />
      </Profiler>
    );
    root.render(
      coordinator
        ? <ActivityCoordinatorScope coordinator={coordinator}>{palette}</ActivityCoordinatorScope>
        : palette,
    );
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

function flushRemoteSearchDebounce() {
  act(() => {
    vi.advanceTimersByTime(250);
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
    expect(input?.getAttribute("placeholder")).toBe("Search issues, chats, agents, projects, skills, library...");

    const dialog = container.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.style.left).toBe("50vw");
    expect(dialog?.style.top).toBe("50vh");
  });

  it("uses a bounded preview query for initial issue results", () => {
    const container = renderCommandPalette();

    openCommandPalette(container);

    expect(observedQueryKeys).toContainEqual(["issues", "org-1", "command-palette", "list", 20]);
    expect(observedQueryKeys).not.toContainEqual(["issues", "org-1"]);
  });

  it("does not rerender or repeat requests for unrelated ActivityCoordinator updates", () => {
    const coordinator = new ActivityCoordinator("org-1");
    let renderCount = 0;
    const container = renderCommandPalette({
      coordinator,
      onRender: () => {
        renderCount += 1;
      },
    });
    openCommandPalette(container);
    const settledRenderCount = renderCount;
    const settledQueryCount = observedQueryKeys.length;

    act(() => {
      coordinator.updateSummary("chat:background-chat", {
        status: "running",
        latestActivityAt: "2026-06-09T12:00:01.000Z",
      });
      coordinator.updateSummary("issue:background-issue", {
        status: "in_progress",
        latestActivityAt: "2026-06-09T12:00:02.000Z",
      });
    });

    expect(renderCount).toBe(settledRenderCount);
    expect(observedQueryKeys).toHaveLength(settledQueryCount);
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
    expect(input?.getAttribute("placeholder")).toBe("Search issues, chats, agents, projects, skills, library...");

    const searchLaunch = container.querySelector('button[aria-label="Search launch"]');
    act(() => {
      searchLaunch?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    flushRemoteSearchDebounce();

    expect(container.textContent).toContain("Chats");
    expect(container.textContent).toContain("Launch planning");
    expect(container.textContent).toContain("Message body matched launch planning notes.");
    expect(container.textContent).toContain("20m ago");
    expect(container.textContent).not.toContain("active");

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
    flushRemoteSearchDebounce();

    expect(observedQueryKeys).toContainEqual([
      "issues",
      "org-1",
      "command-palette",
      "search",
      "launch",
      "title,description,comment",
      20,
    ]);
    expect(container.textContent).toContain("Issues");
    expect(container.textContent).toContain("RUD-498");
    expect(container.textContent).toContain("Global search regression");
    expect(container.querySelector('[data-slot="issue-status-icon"][data-status="todo"]')).not.toBeNull();
  });

  it("shows a loading state while global search results are pending", () => {
    queryStateByKey.set(JSON.stringify([
      "issues",
      "org-1",
      "command-palette",
      "search",
      "pending",
      "title,description,comment",
      20,
    ]), { data: undefined, isFetching: true, isLoading: true });
    queryStateByKey.set(JSON.stringify([
      "chats",
      "org-1",
      "command-palette",
      "search",
      "all",
      "pending",
      20,
    ]), { data: undefined, isFetching: true, isLoading: true });
    const container = renderCommandPalette();
    const input = openCommandPalette(container);

    changeInput(input, "pending");
    flushRemoteSearchDebounce();

    expect(container.textContent).toContain("Searching...");
    expect(container.textContent).not.toContain("No results found.");
    expect(container.querySelector('[role="dialog"]')?.className).toContain("command-palette-content--searching");
  });

  it("does not render the command palette loading ring when cached results are visible", () => {
    queryStateByKey.set(JSON.stringify([
      "issues",
      "org-1",
      "command-palette",
      "search",
      "pending",
      "title,description,comment",
      20,
    ]), {
      data: [
        {
          id: "issue-cached",
          identifier: "RUD-732",
          title: "Cached pending issue",
          status: "todo",
          assigneeAgentId: null,
        },
      ],
      isFetching: true,
    });
    const container = renderCommandPalette();
    const input = openCommandPalette(container);

    changeInput(input, "pending");
    flushRemoteSearchDebounce();

    expect(container.textContent).toContain("Cached pending issue");
    expect(container.textContent).not.toContain("Searching...");
    expect(container.querySelector('[role="dialog"]')?.className).not.toContain("command-palette-content--searching");
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
    expect(container.querySelector("input")?.getAttribute("placeholder")).toBe("Search issues, chats, agents, projects, skills, library...");
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
    flushRemoteSearchDebounce();

    expect(container.textContent).toContain("Global search regression");
    expect(container.textContent).not.toContain("Launch planning");
    expect(observedQueryKeys).toContainEqual([
      "issues",
      "org-1",
      "command-palette",
      "search",
      "status icon",
      "title,description,comment",
      20,
    ]);
  });

  it("filters the bounded issue preview locally for one-character issue searches", () => {
    queryDataByKey.set(JSON.stringify([
      "issues",
      "org-1",
      "command-palette",
      "list",
      20,
    ]), [
      {
        id: "issue-preview",
        identifier: "RUD-1",
        title: "Release readiness",
        status: "todo",
        assigneeAgentId: null,
      },
      {
        id: "issue-other",
        identifier: "OPS-2",
        title: "Deploy checklist",
        status: "todo",
        assigneeAgentId: null,
      },
    ]);
    const container = renderCommandPalette();
    const input = openCommandPalette(container);

    changeInput(input, "r");

    expect(container.textContent).toContain("Release readiness");
    expect(container.textContent).not.toContain("Deploy checklist");
    expect(observedQueryKeys).not.toContainEqual([
      "issues",
      "org-1",
      "command-palette",
      "search",
      "r",
      "title,description,comment",
      20,
    ]);
  });

  it("shows a pending scope suggestion without entering scoped mode", () => {
    const container = renderCommandPalette();
    const input = openCommandPalette(container);

    changeInput(input, "iss");

    expect(container.querySelector("input")?.getAttribute("placeholder")).toBe("Search issues, chats, agents, projects, skills, library...");
    expect(container.textContent).toContain("Search in Issues");
    expect(container.querySelector('[aria-label="Clear Issues search scope"]')).toBeNull();
  });

  it("searches organization skills and navigates to the selected skill", () => {
    const container = renderCommandPalette();
    const input = openCommandPalette(container);

    changeInput(input, "router");

    expect(observedQueryKeys).toContainEqual(["organization-skills", "org-1"]);
    expect(container.textContent).toContain("Skills");
    expect(container.textContent).toContain("development-lifecycle-router-maintainer");
    expect(container.textContent).toContain("Route Rudder development work through lifecycle stages.");

    const skillButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("development-lifecycle-router-maintainer"));
    expect(skillButton?.querySelector(".lucide-boxes")).not.toBeNull();
    expect(skillButton?.querySelector(".lucide-sparkles")).toBeNull();
    act(() => {
      skillButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(navigateMock).toHaveBeenCalledWith("/library?skill=skill-router&skillFile=SKILL.md");
  });

  it("uses the skill blocks icon for the Skills page entry", () => {
    const container = renderCommandPalette();
    openCommandPalette(container);

    const skillsPageButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Skills");
    expect(skillsPageButton?.querySelector(".lucide-boxes")).not.toBeNull();
    expect(skillsPageButton?.querySelector(".lucide-sparkles")).toBeNull();
  });

  it("confirms a skill scope and only renders skill search results", () => {
    const container = renderCommandPalette();
    const input = openCommandPalette(container);

    changeInput(input, "skills ");
    expect(container.querySelector("input")?.getAttribute("placeholder")).toBe("Search Skills...");
    expect(container.textContent).toContain("Skills");

    const scopedInput = container.querySelector<HTMLInputElement>("input");
    expect(scopedInput).not.toBeNull();
    changeInput(scopedInput!, "router");

    expect(container.textContent).toContain("development-lifecycle-router-maintainer");
    expect(container.textContent).not.toContain("Global search regression");
    expect(container.textContent).not.toContain("Launch planning");
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
    expect(container.querySelector("input")?.getAttribute("placeholder")).toBe("Search issues, chats, agents, projects, skills, library...");

    changeInput(container.querySelector<HTMLInputElement>("input")!, "library ");
    const clearButton = container.querySelector<HTMLButtonElement>('[aria-label="Clear Library search scope"]');
    expect(clearButton).not.toBeNull();
    act(() => {
      clearButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector("input")?.getAttribute("placeholder")).toBe("Search issues, chats, agents, projects, skills, library...");
  });
});
