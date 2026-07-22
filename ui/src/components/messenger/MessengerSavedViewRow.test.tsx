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
  DropdownMenuItem: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
  DropdownMenuSub: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuSubContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuSubTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe("MessengerSavedViewRow", () => {
  it("uses a Local App icon without adding thread attention state", () => {
    const entry = {
      id: "entry-a",
      itemKey: "saved_view:saved-a",
      item: {
        type: "saved_view",
        savedView: {
          id: "saved-a",
          title: "MKT dashboard",
          subtitle: "Local app",
          targetPayload: {
            kind: "local_app",
            desktopInstallationId: "installation-a",
            appPublicId: "public-a",
            localBindingId: "binding-a",
            viewInstanceId: "view-a",
          },
        },
      },
    } as unknown as MessengerCustomGroupHydratedSavedViewEntry;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root!.render(
        <MessengerSavedViewRow
          currentGroupId="group-a"
          entry={entry}
          groups={[]}
          onMove={vi.fn()}
          onRemove={vi.fn()}
        />,
      );
    });

    expect(host.querySelector('[data-testid="messenger-saved-view-local-app-icon"]')).not.toBeNull();
    expect(host.textContent).toContain("MKT dashboard");
    expect(host.textContent).not.toContain("unread");
  });
});
