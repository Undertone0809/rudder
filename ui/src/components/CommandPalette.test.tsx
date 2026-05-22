// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { CSSProperties, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "./CommandPalette";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const navigateMock = vi.fn();

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey, enabled }: { queryKey: readonly unknown[]; enabled?: boolean }) => {
    if (!enabled) return { data: [] };
    if (queryKey[0] === "chats" && queryKey[3] === "search" && queryKey[4] === "launch") {
      return {
        data: [
          {
            id: "chat-1",
            title: "Launch planning",
            status: "active",
            summary: null,
            latestReplyPreview: "Latest assistant reply",
            searchPreview: "Message body matched launch planning notes.",
          },
        ],
      };
    }
    if (queryKey[0] === "agents") return { data: [] };
    if (queryKey[0] === "projects") return { data: [] };
    if (queryKey[0] === "issues") return { data: [] };
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
  }: {
    placeholder?: string;
    value?: string;
    onValueChange?: (value: string) => void;
  }) => (
    <>
      <input
        aria-label="Command input"
        placeholder={placeholder}
        value={value}
        onChange={(event) => onValueChange?.(event.currentTarget.value)}
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
  }: {
    children: ReactNode;
    onSelect?: () => void;
  }) => <button type="button" onClick={onSelect}>{children}</button>,
  CommandSeparator: () => <hr />,
}));

let cleanupFn: (() => void) | null = null;

afterEach(() => {
  cleanupFn?.();
  cleanupFn = null;
  navigateMock.mockClear();
  document.body.innerHTML = "";
});

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
    expect(input?.getAttribute("placeholder")).toBe("Search issues, chats, agents, projects...");

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
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
    });

    const input = container.querySelector("input");
    expect(input?.getAttribute("placeholder")).toBe("Search issues, chats, agents, projects...");

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
});
