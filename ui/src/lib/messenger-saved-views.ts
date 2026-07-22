import type {
  MessengerSavedView,
  MessengerSavedViewPlacement,
  MessengerSavedViewTarget,
} from "@rudderhq/shared";
import type { SidePanelTarget } from "./side-panel-targets";
import { sidePanelTargetSupportsSavedView } from "./side-panel-targets";

export type MessengerSavedViewKeepInput = {
  target: MessengerSavedViewTarget;
  title: string;
  subtitle: string | null;
  favicon: string | null;
  clientMutationId: string;
  placement: MessengerSavedViewPlacement;
};

type SavedViewKeepOptions = {
  clientMutationId: string;
  placement: MessengerSavedViewPlacement;
};

export function savedViewPlacementForSidePanelContext(
  contextKey: string,
  resolvedIssueId: string | null = null,
  selectedGroupId: string | null = null,
): MessengerSavedViewPlacement | null {
  if (contextKey.startsWith("chat:")) {
    const conversationId = contextKey.slice("chat:".length).trim();
    return conversationId
      ? { kind: "anchor", anchor: { kind: "chat", conversationId } }
      : null;
  }
  if (contextKey.startsWith("issue:")) {
    return resolvedIssueId
      ? { kind: "anchor", anchor: { kind: "issue", issueId: resolvedIssueId } }
      : null;
  }
  return selectedGroupId ? { kind: "group", groupId: selectedGroupId } : null;
}

function targetPayloadFromSidePanelTarget(target: SidePanelTarget): MessengerSavedViewTarget | null {
  if (!sidePanelTargetSupportsSavedView(target)) return null;
  if (target.kind === "browser") {
    return {
      kind: "browser",
      tabId: target.tabId,
      url: target.url,
      viewInstanceId: target.viewInstanceId ?? target.tabId,
    };
  }
  if (!target.viewInstanceId) return null;
  if (target.kind === "automation") {
    return { kind: "automation", automationId: target.automationId, viewInstanceId: target.viewInstanceId };
  }
  if (target.kind === "library_document") {
    return { kind: "library_document", documentId: target.documentId, viewInstanceId: target.viewInstanceId };
  }
  if (target.kind === "library_entry" && target.path) {
    return { kind: "library_entry", entryId: target.entryId, path: target.path, viewInstanceId: target.viewInstanceId };
  }
  if (target.kind === "library_file") {
    return { kind: "library_file", filePath: target.filePath, viewInstanceId: target.viewInstanceId };
  }
  if (target.kind === "library_directory") {
    return { kind: "library_directory", directoryPath: target.directoryPath, viewInstanceId: target.viewInstanceId };
  }
  if (target.kind === "local_app") {
    return {
      kind: "local_app",
      desktopInstallationId: target.desktopInstallationId,
      appPublicId: target.appPublicId,
      localBindingId: target.localBindingId,
      viewInstanceId: target.viewInstanceId,
    };
  }
  return null;
}

function savedViewSubtitle(target: SidePanelTarget) {
  if (target.kind === "browser") return target.url;
  if (target.kind === "automation") return "Automation";
  if (target.kind === "library_document") return "Library document";
  if (target.kind === "library_entry") return target.path;
  if (target.kind === "library_file") return target.filePath;
  if (target.kind === "library_directory") return target.directoryPath || "Library";
  if (target.kind === "local_app") return "Local app";
  return null;
}

export function savedViewKeepInputFromSidePanelTarget(
  target: SidePanelTarget,
  options: SavedViewKeepOptions,
): MessengerSavedViewKeepInput | null {
  const targetPayload = targetPayloadFromSidePanelTarget(target);
  if (!targetPayload) return null;
  return {
    target: targetPayload,
    title: target.label,
    subtitle: savedViewSubtitle(target),
    favicon: target.kind === "browser" ? target.favicon ?? null : null,
    clientMutationId: options.clientMutationId,
    placement: options.placement,
  };
}

export function messengerSavedViewRoute(savedViewId: string) {
  return `/messenger/saved/${encodeURIComponent(savedViewId)}`;
}

export function sidePanelTargetFromSavedView(savedView: MessengerSavedView): SidePanelTarget | null {
  const target = savedView.targetPayload;
  const common = { label: savedView.title, viewInstanceId: target.viewInstanceId };
  if (target.kind === "browser") {
    return {
      ...common,
      kind: "browser",
      tabId: target.tabId,
      url: target.url,
      favicon: savedView.favicon ?? undefined,
      savedViewRecovery: {
        id: savedView.id,
        persistedMetadata: {
          target,
          title: savedView.title,
          subtitle: savedView.subtitle,
          favicon: savedView.favicon,
        },
      },
    };
  }
  if (target.kind === "automation") return { ...common, kind: "automation", automationId: target.automationId };
  if (target.kind === "library_document") return { ...common, kind: "library_document", documentId: target.documentId };
  if (target.kind === "library_entry") return { ...common, kind: "library_entry", entryId: target.entryId, path: target.path };
  if (target.kind === "library_file") return { ...common, kind: "library_file", filePath: target.filePath };
  if (target.kind === "library_directory") return { ...common, kind: "library_directory", directoryPath: target.directoryPath };
  if (target.kind === "local_app") {
    return {
      ...common,
      kind: "local_app",
      desktopInstallationId: target.desktopInstallationId,
      appPublicId: target.appPublicId,
      localBindingId: target.localBindingId,
    };
  }
  return null;
}
