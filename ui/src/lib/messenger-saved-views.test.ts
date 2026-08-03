import type { MessengerSavedView } from "@rudderhq/shared";
import { describe, expect, it } from "vitest";
import {
  localAppSavedViewRoute,
  messengerSavedViewRoute,
  savedViewKeepInputFromSidePanelTarget,
  savedViewPlacementForSidePanelContext,
  sidePanelTargetFromSavedView,
} from "./messenger-saved-views";

describe("Messenger Saved View UI model", () => {
  it("converts a normalized Side Panel file into the atomic keep payload", () => {
    expect(savedViewKeepInputFromSidePanelTarget({
      kind: "library_file",
      filePath: "docs/spec.md",
      label: "Spec",
      viewInstanceId: "view-1",
    }, {
      clientMutationId: "00000000-0000-4000-8000-000000000001",
      placement: {
        kind: "anchor",
        anchor: { kind: "chat", conversationId: "10000000-0000-4000-8000-000000000001" },
      },
    })).toEqual({
      target: {
        kind: "library_file",
        filePath: "docs/spec.md",
        viewInstanceId: "view-1",
      },
      title: "Spec",
      subtitle: "docs/spec.md",
      favicon: null,
      clientMutationId: "00000000-0000-4000-8000-000000000001",
      placement: {
        kind: "anchor",
        anchor: { kind: "chat", conversationId: "10000000-0000-4000-8000-000000000001" },
      },
    });
  });

  it("rejects targets that cannot become Saved Views", () => {
    expect(savedViewKeepInputFromSidePanelTarget({
      kind: "local_file",
      filePath: "/private/evidence.md",
      label: "evidence.md",
    }, {
      clientMutationId: "00000000-0000-4000-8000-000000000001",
      placement: { kind: "group", groupId: "20000000-0000-4000-8000-000000000001" },
    })).toBeNull();
  });

  it("anchors stable Chat and resolved Issue hosts, while global views require a chosen group", () => {
    expect(savedViewPlacementForSidePanelContext("chat:10000000-0000-4000-8000-000000000001")).toEqual({
      kind: "anchor",
      anchor: { kind: "chat", conversationId: "10000000-0000-4000-8000-000000000001" },
    });
    expect(savedViewPlacementForSidePanelContext("issue:RUD-42")).toBeNull();
    expect(savedViewPlacementForSidePanelContext(
      "issue:RUD-42",
      "20000000-0000-4000-8000-000000000001",
    )).toEqual({
      kind: "anchor",
      anchor: { kind: "issue", issueId: "20000000-0000-4000-8000-000000000001" },
    });
    expect(savedViewPlacementForSidePanelContext(
      "organization:org-1:global",
      null,
      "30000000-0000-4000-8000-000000000001",
    )).toEqual({ kind: "group", groupId: "30000000-0000-4000-8000-000000000001" });
    expect(savedViewPlacementForSidePanelContext("organization:org-1:global")).toBeNull();
  });

  it("restores the exact Saved View instance and stable Messenger route", () => {
    const savedView = {
      id: "30000000-0000-4000-8000-000000000001",
      title: "Spec",
      subtitle: "docs/spec.md",
      favicon: null,
      targetPayload: {
        kind: "library_file",
        filePath: "docs/spec.md",
        viewInstanceId: "view-exact",
      },
    } as MessengerSavedView;

    expect(messengerSavedViewRoute(savedView.id)).toBe(
      "/messenger/saved/30000000-0000-4000-8000-000000000001",
    );
    expect(localAppSavedViewRoute(savedView.id)).toBe(
      "/apps/saved/30000000-0000-4000-8000-000000000001",
    );
    expect(sidePanelTargetFromSavedView(savedView)).toEqual({
      kind: "library_file",
      filePath: "docs/spec.md",
      label: "Spec",
      viewInstanceId: "view-exact",
    });
  });

  it("round-trips Browser favicon recovery metadata", () => {
    const options = {
      clientMutationId: "00000000-0000-4000-8000-000000000001",
      placement: { kind: "group" as const, groupId: "20000000-0000-4000-8000-000000000001" },
    };
    expect(savedViewKeepInputFromSidePanelTarget({
      kind: "browser",
      tabId: "browser-tab-1",
      url: "https://example.com/dashboard",
      label: "Dashboard",
      favicon: "https://example.com/favicon.ico",
      viewInstanceId: "browser-view-1",
    }, options)).toMatchObject({
      favicon: "https://example.com/favicon.ico",
    });

    const savedView = {
      id: "30000000-0000-4000-8000-000000000001",
      title: "Dashboard",
      subtitle: "https://example.com/dashboard",
      favicon: "https://example.com/favicon.ico",
      targetPayload: {
        kind: "browser",
        tabId: "browser-tab-1",
        url: "https://example.com/dashboard",
        viewInstanceId: "browser-view-1",
      },
    } as MessengerSavedView;
    const restored = sidePanelTargetFromSavedView(savedView);
    expect(restored).toMatchObject({
      favicon: "https://example.com/favicon.ico",
      savedViewRecovery: {
        id: savedView.id,
        persistedMetadata: {
          title: "Dashboard",
          subtitle: "https://example.com/dashboard",
        },
      },
    });
    const keptAgain = savedViewKeepInputFromSidePanelTarget(restored!, options);
    expect(keptAgain?.target).toEqual({
      kind: "browser",
      tabId: "browser-tab-1",
      url: "https://example.com/dashboard",
      viewInstanceId: "browser-view-1",
    });
    expect(keptAgain?.target).not.toHaveProperty("savedViewRecovery");
  });

  it("keeps and restores a Local App using only opaque identity", () => {
    const input = savedViewKeepInputFromSidePanelTarget({
      kind: "local_app",
      desktopInstallationId: "desktop-installation",
      appPublicId: "public-app",
      localBindingId: "local-binding",
      label: "Marketing command center",
      viewInstanceId: "local-view-1",
    }, {
      clientMutationId: "00000000-0000-4000-8000-000000000001",
      placement: { kind: "group", groupId: "20000000-0000-4000-8000-000000000001" },
    });

    expect(input).toEqual({
      target: {
        kind: "local_app",
        desktopInstallationId: "desktop-installation",
        appPublicId: "public-app",
        localBindingId: "local-binding",
        viewInstanceId: "local-view-1",
      },
      title: "Marketing command center",
      subtitle: "Local app",
      favicon: null,
      clientMutationId: "00000000-0000-4000-8000-000000000001",
      placement: { kind: "group", groupId: "20000000-0000-4000-8000-000000000001" },
    });
    expect(Object.keys(input!.target).sort()).toEqual([
      "appPublicId",
      "desktopInstallationId",
      "kind",
      "localBindingId",
      "viewInstanceId",
    ]);

    const savedView = {
      id: "30000000-0000-4000-8000-000000000001",
      title: "Marketing command center",
      subtitle: "Local app",
      favicon: null,
      targetPayload: input!.target,
    } as MessengerSavedView;
    expect(sidePanelTargetFromSavedView(savedView)).toEqual({
      kind: "local_app",
      desktopInstallationId: "desktop-installation",
      appPublicId: "public-app",
      localBindingId: "local-binding",
      label: "Marketing command center",
      viewInstanceId: "local-view-1",
    });
  });
});
