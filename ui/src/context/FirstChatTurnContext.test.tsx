// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FirstChatTurnProvider, preserveFirstChatTurnOwnerState, useFirstChatTurnStore } from "./FirstChatTurnContext";
import { FirstChatTurnStore } from "@/lib/chat-first-turn-store";

const organizationState = vi.hoisted(() => ({ selectedOrganizationId: "org-a" }));

vi.mock("@/context/OrganizationContext", () => ({
  useOrganization: () => ({ selectedOrganizationId: organizationState.selectedOrganizationId }),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let store: FirstChatTurnStore | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  store = null;
  organizationState.selectedOrganizationId = "org-a";
  document.body.innerHTML = "";
});

function RouteOwnerHarness() {
  const currentStore = useFirstChatTurnStore();
  const location = useLocation();
  const navigate = useNavigate();
  store = currentStore;

  return (
    <>
      <button
        type="button"
        data-testid="clear-prefill"
        onClick={() => navigate("/legacy/messenger/chat", {
          replace: true,
          state: preserveFirstChatTurnOwnerState(location),
        })}
      >
        Clear prefill
      </button>
      <button
        type="button"
        data-testid="canonicalize-prefix"
        onClick={() => navigate("/canonical/messenger/chat", {
          replace: true,
          state: preserveFirstChatTurnOwnerState(location),
        })}
      >
        Canonicalize prefix
      </button>
      <button
        type="button"
        data-testid="replace-cross-org"
        onClick={() => navigate("/other/messenger/chat", {
          replace: true,
          state: preserveFirstChatTurnOwnerState(location),
        })}
      >
        Switch organization
      </button>
      <button
        type="button"
        data-testid="reset-owner"
        onClick={() => navigate(location.pathname, { replace: true })}
      >
        Reset route owner
      </button>
      <button
        type="button"
        data-testid="push-same-route"
        onClick={() => navigate(location.pathname, {
          state: preserveFirstChatTurnOwnerState(location),
        })}
      >
        Push same route
      </button>
      <output data-testid="current-route">{location.pathname}</output>
    </>
  );
}

function renderRouteOwner() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const render = () => root?.render(
    <MemoryRouter initialEntries={["/legacy/messenger/chat?agentId=agent-1"]}>
      <FirstChatTurnProvider>
        <RouteOwnerHarness />
      </FirstChatTurnProvider>
    </MemoryRouter>,
  );
  act(() => render());
  return { container };
}

describe("first chat route ownership", () => {
  it("keeps ownership through chained replacements and revokes it on org and push boundaries", () => {
    const { container } = renderRouteOwner();
    const firstTurnStore = store!;
    const firstOwner = firstTurnStore.getOwner()!;
    expect(firstTurnStore.begin(firstOwner, {
      streamKey: "first",
      body: "first message",
      files: [],
      createdAt: new Date(),
    })).toBe(true);

    act(() => container.querySelector<HTMLButtonElement>("[data-testid=clear-prefill]")?.click());
    expect(firstTurnStore.getOwner()).toBe(firstOwner);
    expect(firstTurnStore.getSnapshot().pending?.streamKey).toBe("first");

    act(() => container.querySelector<HTMLButtonElement>("[data-testid=canonicalize-prefix]")?.click());
    expect(container.querySelector("[data-testid=current-route]")?.textContent).toBe("/canonical/messenger/chat");
    expect(firstTurnStore.getOwner()).toBe(firstOwner);
    expect(firstTurnStore.owns(firstOwner, "first")).toBe(true);

    act(() => {
      organizationState.selectedOrganizationId = "org-b";
      container.querySelector<HTMLButtonElement>("[data-testid=replace-cross-org]")?.click();
    });
    expect(container.querySelector("[data-testid=current-route]")?.textContent).toBe("/other/messenger/chat");
    expect(firstTurnStore.getOwner()).not.toBe(firstOwner);
    expect(firstTurnStore.getSnapshot().pending).toBeNull();

    act(() => container.querySelector<HTMLButtonElement>("[data-testid=reset-owner]")?.click());
    const secondOwner = firstTurnStore.getOwner()!;
    expect(firstTurnStore.begin(secondOwner, {
      streamKey: "second",
      body: "second message",
      files: [],
      createdAt: new Date(),
    })).toBe(true);
    act(() => container.querySelector<HTMLButtonElement>("[data-testid=push-same-route]")?.click());
    expect(firstTurnStore.getOwner()).not.toBe(secondOwner);
    expect(firstTurnStore.getSnapshot().pending).toBeNull();
  });
});
