import type { TranscriptEntry } from "@/agent-runtimes";
import { parseMentionChipHref } from "@/lib/mention-chips";
import type { ChatInlineAnnotationInput } from "@rudderhq/shared";

export type SidePanelTarget =
  | {
      kind: "issue";
      issueId: string;
      ref: string | null;
      commentId: string | null;
      label: string;
    }
  | {
      kind: "issue_proposal";
      conversationId: string;
      messageId: string;
      label: string;
    }
  | {
      kind: "automation";
      automationId: string;
      label: string;
      viewInstanceId?: string;
    }
  | {
      kind: "chat";
      conversationId: string;
      messageId: string | null;
      label: string;
    }
  | {
      kind: "subagent";
      callId: string;
      threadId: string;
      avatarSeed: string;
      label: string;
      senderLabel: string;
      prompt: string;
      model: string | null;
      reasoningEffort: string | null;
      status: string;
      response: string | null;
      entries: TranscriptEntry[];
    }
  | {
      kind: "side_chat";
      sourceConversationId: string;
      sourceMessageId: string | null;
      sourcePreview: string | null;
      inlineAnnotations?: ChatInlineAnnotationInput[];
      conversationId: string | null;
      clientMutationId: string;
      label: string;
    }
  | {
      kind: "library_document";
      documentId: string;
      label: string;
      viewInstanceId?: string;
    }
  | {
      kind: "library_entry";
      entryId: string;
      path: string | null;
      label: string;
      viewInstanceId?: string;
    }
  | {
      kind: "library_file";
      filePath: string;
      label: string;
      viewInstanceId?: string;
    }
  | {
      kind: "local_file";
      filePath: string;
      label: string;
    }
  | {
      kind: "organization_skill_file";
      skillId: string;
      filePath: string;
      label: string;
    }
  | {
      kind: "local_apps";
      label: string;
    }
  | {
      kind: "local_app";
      desktopInstallationId: string;
      appPublicId: string;
      localBindingId: string;
      label: string;
      viewInstanceId?: string;
    }
  | {
      kind: "library_directory";
      directoryPath: string;
      label: string;
      viewInstanceId?: string;
    }
  | {
      kind: "browser";
      url: string;
      label: string;
      tabId: string;
      favicon?: string;
      dedupeKey?: string;
      viewInstanceId?: string;
      /** Renderer-only recovery metadata. Saved View API payloads explicitly omit this field. */
      savedViewRecovery?: {
        id: string;
        persistedMetadata: {
          target: {
            kind: "browser";
            tabId: string;
            url: string;
            viewInstanceId: string;
          };
          title: string;
          subtitle: string | null;
          favicon: string | null;
        };
      };
    }
  | {
      kind: "placeholder";
      targetKind: "issue" | "automation" | "chat";
      label: string;
    };

function sidePanelLabel(label: string | null | undefined, fallback: string) {
  return label?.trim() || fallback;
}

function basenameLabel(path: string, fallback: string) {
  return path.split("/").filter(Boolean).at(-1) ?? fallback;
}

function parseUrl(href: string) {
  try {
    return new URL(href, "http://rudder.local");
  } catch {
    return null;
  }
}

function chatMessageIdFromUrl(url: URL) {
  return (url.searchParams.get("messageId") ?? url.searchParams.get("targetMessageId") ?? "").trim() || null;
}

function commentIdFromHash(url: URL) {
  const hash = decodeURIComponent(url.hash.replace(/^#/, "")).trim();
  return hash.startsWith("comment-") ? hash.slice("comment-".length).trim() || null : null;
}

export function sidePanelCanonicalTargetKey(target: SidePanelTarget) {
  if (target.kind === "issue") return `issue:${target.issueId}:${target.commentId ?? ""}`;
  if (target.kind === "issue_proposal") {
    return `issue-proposal:${target.conversationId}:${target.messageId}`;
  }
  if (target.kind === "automation") return `automation:${target.automationId}`;
  if (target.kind === "chat") return `chat:${target.conversationId}:${target.messageId ?? ""}`;
  if (target.kind === "subagent") return `subagent:${target.callId}:${target.threadId}`;
  if (target.kind === "side_chat") return target.conversationId
    ? `side-chat:${target.conversationId}`
    : `side-chat:draft:${target.clientMutationId}`;
  if (target.kind === "library_document") return `library-document:${target.documentId}`;
  if (target.kind === "library_entry") return `library-entry:${target.entryId}:${target.path ?? ""}`;
  if (target.kind === "library_file") return `library-file:${target.filePath}`;
  if (target.kind === "local_file") return `local-file:${target.filePath}`;
  if (target.kind === "organization_skill_file") {
    return `organization-skill-file:${target.skillId}:${target.filePath}`;
  }
  if (target.kind === "local_apps") return "local-apps";
  if (target.kind === "local_app") {
    return `local-app:${encodeURIComponent(target.desktopInstallationId)}:${encodeURIComponent(target.appPublicId)}:${encodeURIComponent(target.localBindingId)}`;
  }
  if (target.kind === "library_directory") return `library-directory:${target.directoryPath}`;
  if (target.kind === "browser") return `browser-tab:${target.tabId}`;
  return `placeholder:${target.targetKind}`;
}

export function sidePanelTargetSupportsSavedView(
  target: SidePanelTarget,
): target is Extract<SidePanelTarget, {
  kind: "automation" | "library_document" | "library_entry" | "library_file" | "library_directory" | "browser" | "local_app";
}> {
  return target.kind === "automation"
    || target.kind === "library_document"
    || target.kind === "library_entry"
    || target.kind === "library_file"
    || target.kind === "library_directory"
    || target.kind === "browser"
    || target.kind === "local_app";
}

export function sidePanelTargetKey(target: SidePanelTarget) {
  const canonicalKey = sidePanelCanonicalTargetKey(target);
  if (target.kind === "browser" || !sidePanelTargetSupportsSavedView(target) || !target.viewInstanceId) {
    return canonicalKey;
  }
  return `${canonicalKey}:view:${target.viewInstanceId}`;
}

export function sidePanelFullPageHref(target: SidePanelTarget): string | null {
  if (target.kind === "issue") {
    const base = `/issues/${target.issueId}`;
    return target.commentId ? `${base}#comment-${encodeURIComponent(target.commentId)}` : base;
  }
  if (target.kind === "issue_proposal") return null;
  if (target.kind === "automation") return `/automations/${target.automationId}`;
  if (target.kind === "chat") {
    const base = `/messenger/chat/${target.conversationId}`;
    return target.messageId ? `${base}?messageId=${encodeURIComponent(target.messageId)}` : base;
  }
  if (target.kind === "subagent") return null;
  if (target.kind === "side_chat") {
    if (target.conversationId) return `/messenger/chat/${target.conversationId}`;
    const base = `/messenger/chat/${target.sourceConversationId}`;
    return target.sourceMessageId ? `${base}?messageId=${encodeURIComponent(target.sourceMessageId)}` : base;
  }
  if (target.kind === "library_document") return `/library?document=${encodeURIComponent(target.documentId)}`;
  if (target.kind === "library_file") return `/library?path=${encodeURIComponent(target.filePath)}`;
  if (target.kind === "local_file") return null;
  if (target.kind === "organization_skill_file") {
    const search = new URLSearchParams({
      skill: target.skillId,
      skillFile: target.filePath,
    });
    return `/library?${search.toString()}`;
  }
  if (target.kind === "local_apps" || target.kind === "local_app") return null;
  if (target.kind === "library_directory") {
    return target.directoryPath
      ? `/library?directory=${encodeURIComponent(target.directoryPath)}`
      : "/library";
  }
  if (target.kind === "library_entry") {
    const search = new URLSearchParams({ entry: target.entryId });
    if (target.path) search.set("path", target.path);
    return `/library?${search.toString()}`;
  }
  if (target.kind === "browser") return target.url;
  if (target.targetKind === "issue") return "/issues";
  if (target.targetKind === "automation") return "/automations";
  return "/messenger/chat";
}

function sidePanelTargetFromInternalRouteHref(
  href: string,
  label?: string | null,
): SidePanelTarget | null {
  const url = parseUrl(href);
  if (!url || url.origin !== "http://rudder.local") return null;

  const segments = url.pathname.split("/").filter(Boolean).map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });

  const issueRoute = segments.length >= 2 && segments.at(-2) === "issues" ? segments.at(-1)?.trim() : "";
  if (issueRoute) {
    return {
      kind: "issue",
      issueId: issueRoute,
      ref: label?.trim() || null,
      commentId: commentIdFromHash(url),
      label: sidePanelLabel(label, "Issue"),
    };
  }

  const automationRoute = segments.length >= 2 && segments.at(-2) === "automations" ? segments.at(-1)?.trim() : "";
  if (automationRoute) {
    return {
      kind: "automation",
      automationId: automationRoute,
      label: sidePanelLabel(label, url.searchParams.get("t") ?? url.searchParams.get("title") ?? "Automation"),
    };
  }

  const chatRoute = segments.length >= 2 && segments.at(-2) === "chat" ? segments.at(-1)?.trim() : "";
  if (chatRoute) {
    return {
      kind: "chat",
      conversationId: chatRoute,
      messageId: chatMessageIdFromUrl(url),
      label: sidePanelLabel(label, "Chat"),
    };
  }

  if (segments.at(-1) === "library") {
    const skillId = (url.searchParams.get("skill") ?? "").trim();
    if (skillId) {
      return {
        kind: "organization_skill_file",
        skillId,
        filePath: (url.searchParams.get("skillFile") ?? "SKILL.md").trim() || "SKILL.md",
        label: sidePanelLabel(label, "Skill"),
      };
    }

    const documentId = (url.searchParams.get("document") ?? url.searchParams.get("doc") ?? "").trim();
    if (documentId) {
      return {
        kind: "library_document",
        documentId,
        label: sidePanelLabel(label, url.searchParams.get("t") ?? url.searchParams.get("title") ?? "Library document"),
      };
    }

    const filePath = (url.searchParams.get("path") ?? "").trim();
    if (filePath) {
      return {
        kind: "library_file",
        filePath,
        label: sidePanelLabel(label, basenameLabel(filePath, "Library file")),
      };
    }

    const directoryPath = (url.searchParams.get("directory") ?? "").trim();
    if (directoryPath) {
      return {
        kind: "library_directory",
        directoryPath,
        label: sidePanelLabel(label, basenameLabel(directoryPath, "Library directory")),
      };
    }

    const entryId = (url.searchParams.get("entry") ?? "").trim();
    if (entryId) {
      return {
        kind: "library_entry",
        entryId,
        path: filePath || null,
        label: sidePanelLabel(label, entryId),
      };
    }
  }

  return null;
}

export function sidePanelTargetFromHref(
  href: string,
  label?: string | null,
): SidePanelTarget | null {
  const mention = parseMentionChipHref(href);
  if (!mention) return sidePanelTargetFromInternalRouteHref(href, label);

  if (mention.kind === "issue") {
    return {
      kind: "issue",
      issueId: mention.issueId,
      ref: mention.ref ?? label?.trim() ?? null,
      commentId: mention.commentId,
      label: sidePanelLabel(label, mention.ref ?? "Issue"),
    };
  }

  if (mention.kind === "automation") {
    return {
      kind: "automation",
      automationId: mention.automationId,
      label: sidePanelLabel(label, mention.title ?? "Automation"),
    };
  }

  if (mention.kind === "chat") {
    const url = parseUrl(href);
    return {
      kind: "chat",
      conversationId: mention.conversationId,
      messageId: url ? chatMessageIdFromUrl(url) : null,
      label: sidePanelLabel(label, mention.title ?? "Chat"),
    };
  }

  if (mention.kind === "library_doc") {
    return {
      kind: "library_document",
      documentId: mention.documentId,
      label: sidePanelLabel(label, mention.title ?? "Library document"),
    };
  }

  if (mention.kind === "library_entry") {
    return {
      kind: "library_entry",
      entryId: mention.entryId,
      path: mention.path,
      label: sidePanelLabel(label, mention.title ?? mention.path ?? "Library entry"),
    };
  }

  if (mention.kind === "library_file") {
    return {
      kind: "library_file",
      filePath: mention.filePath,
      label: sidePanelLabel(label, mention.title ?? basenameLabel(mention.filePath, "Library file")),
    };
  }

  if (mention.kind === "library_directory") {
    return {
      kind: "library_directory",
      directoryPath: mention.directoryPath,
      label: sidePanelLabel(label, mention.title ?? basenameLabel(mention.directoryPath, "Library directory")),
    };
  }

  return null;
}
