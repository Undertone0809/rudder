// @vitest-environment jsdom

import type { MessengerCustomGroupHydratedSavedViewEntry } from "@rudderhq/shared";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessengerSavedViewRow } from "./MessengerSavedViewRow";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => <a href={to} {...props}>{children}</a>,
}));
vi.mock("../ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuItem: ({
    children,
    onClick,
  }: {
    children: ReactNode;
    onClick?: () => void;
  }) => <button type="button" onClick={onClick}>{children}</button>,
  DropdownMenuSub: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuSubContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuSubTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function savedViewEntry({
  favicon = null,
  kind = "browser",
  subtitle = "https://example.com/private/path?token=secret",
  title = "Example dashboard",
}: {
  favicon?: string | null;
  kind?:
    | "automation"
    | "browser"
    | "library_directory"
    | "library_document"
    | "library_entry"
    | "library_file"
    | "local_app";
  subtitle?: string | null;
  title?: string;
} = {}) {
  const targetPayload = kind === "browser"
    ? {
      kind,
      tabId: "tab-a",
      url: "https://example.com/private/path?token=secret",
      viewInstanceId: "view-a",
    }
    : kind === "automation"
      ? { kind, automationId: "automation-a", viewInstanceId: "view-a" }
      : kind === "library_document"
        ? { kind, documentId: "document-a", viewInstanceId: "view-a" }
        : kind === "library_entry"
          ? { kind, entryId: "entry-a", path: "dashboard/README.md", viewInstanceId: "view-a" }
          : kind === "library_file"
            ? { kind, filePath: "dashboard/README.md", viewInstanceId: "view-a" }
            : kind === "library_directory"
              ? { kind, directoryPath: "dashboard", viewInstanceId: "view-a" }
              : {
                kind,
                desktopInstallationId: "installation-a",
                appPublicId: "public-a",
                localBindingId: "binding-a",
                viewInstanceId: "view-a",
              };
  return {
    id: "entry-a",
    itemKey: "saved-view:saved-a",
    item: {
      type: "saved_view",
      itemKey: "saved-view:saved-a",
      title,
      savedView: {
        id: "saved-a",
        title,
        subtitle,
        favicon,
        targetPayload,
      },
    },
  } as unknown as MessengerCustomGroupHydratedSavedViewEntry;
}

function renderRow({
  active = false,
  currentGroupId = "group-a",
  entry = savedViewEntry(),
  groups = [],
  onMove = vi.fn(),
  onMoveOutOfGroup = vi.fn(),
}: {
  active?: boolean;
  currentGroupId?: string | null;
  entry?: MessengerCustomGroupHydratedSavedViewEntry;
  groups?: Array<{ id: string; name: string }>;
  onMove?: ReturnType<typeof vi.fn>;
  onMoveOutOfGroup?: ReturnType<typeof vi.fn>;
} = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <MessengerSavedViewRow
        active={active}
        currentGroupId={currentGroupId}
        density="compact"
        dragHandleProps={{
          attributes: {
            role: "button",
            tabIndex: 0,
            "aria-disabled": false,
            "aria-pressed": false,
            "aria-roledescription": "sortable",
            "aria-describedby": "saved-view-drag-instructions",
          },
          listeners: undefined,
        }}
        entry={entry}
        groups={groups as never}
        onMove={onMove}
        onMoveOutOfGroup={onMoveOutOfGroup}
        onRemove={vi.fn()}
      />,
    );
  });
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe("MessengerSavedViewRow", () => {
  it("shows an accepted Browser favicon without leaking its URL", () => {
    renderRow({
      entry: savedViewEntry({
        favicon: "https://example.com/favicon.ico",
      }),
    });

    const row = host!.querySelector('[data-testid="messenger-saved-view-entry-a"]');
    const favicon = host!.querySelector<HTMLImageElement>(
      '[data-testid="messenger-saved-view-browser-favicon"]',
    );
    expect(favicon?.src).toBe("https://example.com/favicon.ico");
    expect(row?.textContent).toContain("Example dashboard");
    expect(row?.textContent).not.toContain("https://");
    expect(row?.getAttribute("aria-label")).not.toContain("https://");
    expect(row?.getAttribute("title")).not.toContain("https://");
  });

  it("reduces a URL-shaped Browser title to its domain", () => {
    renderRow({
      entry: savedViewEntry({
        title: "https://example.com/private/path?token=secret",
      }),
    });

    const row = host!.querySelector('[data-testid="messenger-saved-view-entry-a"]');
    expect(row?.textContent).toContain("example.com");
    expect(row?.textContent).not.toContain("https://");
    expect(row?.textContent).not.toContain("/private");
    expect(row?.getAttribute("aria-label")).toBe("example.com");
  });

  it.each([
    ["Docs — https://internal.example/path?token=x", "Docs — internal.example"],
    ["internal.example/path?token=x", "internal.example"],
    ["internal.example?token=x", "internal.example"],
    ["localhost:3000#secret", "localhost:3000"],
    ["127.0.0.1:3000/private", "127.0.0.1:3000"],
    ["file:///Users/name/private.md", "Local file"],
    ["//private.example/path?token=x", "private.example"],
  ])("removes embedded Browser URL details from %s", (title, expected) => {
    renderRow({ entry: savedViewEntry({ title }) });

    const row = host!.querySelector('[data-testid="messenger-saved-view-entry-a"]');
    expect(row?.textContent).toContain(expected);
    expect(row?.textContent).not.toContain("/path");
    expect(row?.textContent).not.toContain("/private");
    expect(row?.textContent).not.toContain("token=");
    expect(row?.textContent).not.toContain("#secret");
    expect(row?.textContent).not.toContain("file://");
    expect(row?.getAttribute("aria-label")).toBe(expected);
    expect(row?.getAttribute("title")).toBe(expected);
    expect(
      host!.querySelector("button[aria-label^='Drag ']")?.getAttribute("aria-label"),
    ).toBe(`Drag ${expected}`);
  });

  it.each([
    ["javascript:alert(1)"],
    ["data:text/html,<script>alert(1)</script>"],
    [`https://example.com/${"a".repeat(8_193)}`],
  ])("falls back to the Web icon for an unsafe Browser favicon: %s", (favicon) => {
    renderRow({ entry: savedViewEntry({ favicon }) });

    expect(host!.querySelector('[data-testid="messenger-saved-view-browser-favicon"]')).toBeNull();
    expect(host!.querySelector('[data-testid="messenger-saved-view-browser-fallback-icon"]')).not.toBeNull();
  });

  it("accepts a bounded image data URL as a Browser favicon", () => {
    renderRow({
      entry: savedViewEntry({
        favicon: "data:image/png;base64,iVBORw0KGgo=",
      }),
    });

    expect(
      host!.querySelector<HTMLImageElement>('[data-testid="messenger-saved-view-browser-favicon"]')
        ?.getAttribute("src"),
    ).toBe("data:image/png;base64,iVBORw0KGgo=");
  });

  it("marks only the active Saved View row and exposes the drag affordance", () => {
    renderRow({ active: true });

    const row = host!.querySelector('[data-testid="messenger-saved-view-entry-a"]');
    expect(row?.getAttribute("data-active")).toBe("true");
    expect(host!.querySelector('a[aria-current="page"]')).not.toBeNull();
    expect(host!.querySelector('button[aria-label="Drag Example dashboard"]')).not.toBeNull();
  });

  it.each([
    ["automation", "messenger-saved-view-automation-icon"],
    ["library_document", "messenger-saved-view-document-icon"],
    ["library_entry", "messenger-saved-view-file-icon"],
    ["library_file", "messenger-saved-view-file-icon"],
    ["library_directory", "messenger-saved-view-folder-icon"],
    ["local_app", "messenger-saved-view-local-app-icon"],
  ] as const)("uses the expected %s icon", (kind, testId) => {
    renderRow({ entry: savedViewEntry({ kind }) });

    expect(host!.querySelector(`[data-testid="${testId}"]`)).not.toBeNull();
  });

  it("uses a Local App icon without adding thread attention state", () => {
    renderRow({
      entry: savedViewEntry({
        kind: "local_app",
        subtitle: "Local app",
        title: "MKT dashboard",
      }),
    });

    expect(host!.querySelector('[data-testid="messenger-saved-view-local-app-icon"]')).not.toBeNull();
    expect(host!.textContent).toContain("MKT dashboard");
    expect(host!.textContent).not.toContain("unread");
  });

  it("renders loose and grouped placement actions without inventing group membership", () => {
    const onMove = vi.fn();
    const onMoveOutOfGroup = vi.fn();
    const groups = [
      { id: "group-a", name: "Launch" },
      { id: "group-b", name: "Review" },
    ];

    renderRow({
      currentGroupId: null,
      groups,
      onMove,
      onMoveOutOfGroup,
    });

    expect(host!.textContent).toContain("Move to group");
    expect(host!.textContent).toContain("Launch");
    expect(host!.textContent).toContain("Review");
    expect(host!.textContent).not.toContain("Move out of group");
    act(() => {
      Array.from(host!.querySelectorAll("button"))
        .find((button) => button.textContent === "Launch")
        ?.click();
    });
    expect(onMove).toHaveBeenCalledWith("group-a", "saved-view:saved-a");

    act(() => root?.unmount());
    root = null;
    host?.remove();
    host = null;
    renderRow({
      currentGroupId: "group-a",
      groups,
      onMove,
      onMoveOutOfGroup,
    });

    expect(host!.textContent).not.toContain(">Launch<");
    expect(host!.textContent).toContain("Review");
    const moveLooseButton = Array.from(host!.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Move out of group"));
    expect(moveLooseButton).toBeTruthy();
    act(() => moveLooseButton?.click());
    expect(onMoveOutOfGroup).toHaveBeenCalledWith("saved-view:saved-a");
  });
});
