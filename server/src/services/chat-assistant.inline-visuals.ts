import {
  MAX_CODEX_INLINE_VISUALS,
  MAX_RUDDER_INLINE_VISUAL_FRAGMENT_BYTES,
  parseRudderInlineVisualEnvelopes,
  redactRudderInlineVisualSources,
  replaceRudderInlineVisualSources,
  stripRudderInlineVisualPlacements,
} from "@rudderhq/shared";
import type {
  ChatGeneratedAttachment,
  ChatInlineVisualV1Result,
} from "./chat-assistant.helpers.js";

export function chatAssistantErrorForLog(error: unknown) {
  if (!(error instanceof Error)) {
    return {
      name: "Error",
      message: redactChatInlineVisualDiagnosticText(
        String(error),
        "Chat runtime failed while handling private presentation data",
      ),
    };
  }
  const candidate = error as Error & {
    errorCode?: unknown;
    retryable?: unknown;
    failurePhase?: unknown;
    action?: unknown;
  };
  const message = redactChatInlineVisualDiagnosticText(
    error.message,
    "Chat runtime failed while handling private presentation data",
  );
  const stack = error.stack
    ? redactChatInlineVisualDiagnosticText(error.stack, message)
    : undefined;
  return {
    name: redactChatInlineVisualDiagnosticText(error.name, "Error"),
    message,
    stack,
    ...(typeof candidate.errorCode === "string"
      ? { errorCode: redactChatInlineVisualDiagnosticText(candidate.errorCode, "chat_runtime_exception") }
      : {}),
    ...(typeof candidate.retryable === "boolean" ? { retryable: candidate.retryable } : {}),
    ...(typeof candidate.failurePhase === "string"
      ? { failurePhase: redactChatInlineVisualDiagnosticText(candidate.failurePhase, "runtime") }
      : {}),
    ...(typeof candidate.action === "string"
      ? { action: redactChatInlineVisualDiagnosticText(candidate.action, "retry") }
      : {}),
  };
}

export function redactChatInlineVisualDiagnosticText(
  value: string | null | undefined,
  fallback: string,
) {
  const source = value?.trim();
  if (!source) return fallback;
  const sourceWithoutEnvelopes = redactRudderInlineVisualSources(source);
  if (/<div\b[^>]*\bid\s*=\s*["']widget["']/i.test(sourceWithoutEnvelopes)) return fallback;
  const redacted = stripRudderInlineVisualPlacements(sourceWithoutEnvelopes).trim();
  return redacted || fallback;
}

export function buildChatInlineVisualPromptSection() {
  return [
    "Resolved Rudder built-in skill projection: visualize (Chat v1). This common prompt projection is authoritative even when the runtime has no native skill directory or skill-sync API.",
    "Rudder Chat supports runtime-neutral, message-owned inline visuals. Use this only when an interactive or structured visual materially improves the answer.",
    "Wrap each complete scriptless HTML fragment in this exact v1 envelope:",
    ":::rudder-inline-visual:v1",
    '<div id="widget">...</div>',
    ":::rudder-inline-visual:end",
    "The opening and closing markers must each be on their own line. The fragment must have exactly one <div id=\"widget\"> root, use inline CSS only, contain no JavaScript, event handlers, network requests, external resources, fonts, URLs, or forms, and remain useful without interaction.",
    "Emit at most three fragments. Each fragment must be at most 64 KiB UTF-8, all fragments together at most 128 KiB, and the complete final reply at most 256 KiB.",
    "Do not emit an iframe, file path, attachment id, or provider-specific directive. Do not emit Rudder's canonical placement syntax; Rudder replaces each valid envelope with that internal placement after capture.",
    "If the runtime cannot produce this envelope, return an equivalent Markdown or fenced HTML explanation instead of inventing another embedding protocol.",
  ].join("\n");
}

function rudderInlineVisualFragmentIssue(fragment: string) {
  if (!/<div\b[^>]*\bid\s*=\s*["']widget["'][^>]*>/i.test(fragment)) return "missing_widget";
  if (/<\/?(?:html|head|body|base|script|iframe|frame|object|embed|form|input|button|select|textarea|a|img|image|video|audio|source|link|meta)\b/i.test(fragment)) {
    return "unsafe_fragment";
  }
  if (/\s(?:on[a-z]+|href|src|srcset|action|formaction|poster|data|xlink:href)\s*=/i.test(fragment)) {
    return "unsafe_fragment";
  }
  if (/<style\b[^>]*>[\s\S]*?(?:@import|@font-face|url\s*\(|expression\s*\(|javascript:)[\s\S]*?<\/style>/i.test(fragment)) {
    return "unsafe_fragment";
  }
  return null;
}

export function extractRudderInlineVisualArtifacts(
  body: string,
  options: { reservedSlots?: number } = {},
): {
  body: string;
  attachments: ChatGeneratedAttachment[];
  inlineVisualsV1: ChatInlineVisualV1Result[];
} {
  const parsed = parseRudderInlineVisualEnvelopes(body);
  const reservedSlots = Math.max(0, Math.min(MAX_CODEX_INLINE_VISUALS, options.reservedSlots ?? 0));
  const attachments: ChatGeneratedAttachment[] = [];
  const inlineVisualsV1: ChatInlineVisualV1Result[] = [];
  const replacements: Array<{ start: number; end: number; replacement: string }> = [];

  for (const envelope of parsed.envelopes) {
    const slot = envelope.slot + reservedSlots;
    if (slot >= MAX_CODEX_INLINE_VISUALS) {
      replacements.push({ start: envelope.start, end: envelope.end, replacement: "" });
      continue;
    }
    const file = `inline-visual-${slot + 1}.html`;
    const fragmentIssue = rudderInlineVisualFragmentIssue(envelope.fragment);
    replacements.push({
      start: envelope.start,
      end: envelope.end,
      replacement: `::rudder-inline-vis{slot="${slot}"}`,
    });
    if (fragmentIssue) {
      inlineVisualsV1.push({ version: 1, slot, file, status: "unavailable", reason: fragmentIssue });
      continue;
    }
    const fragmentBody = Buffer.from(envelope.fragment, "utf8");
    if (fragmentBody.length !== envelope.byteSize || fragmentBody.length > MAX_RUDDER_INLINE_VISUAL_FRAGMENT_BYTES) {
      inlineVisualsV1.push({ version: 1, slot, file, status: "unavailable", reason: "fragment_size_limit" });
      continue;
    }
    inlineVisualsV1.push({ version: 1, slot, file, status: "captured", byteSize: fragmentBody.length });
    attachments.push({
      source: "rudder_inline_visual",
      originalFilename: file,
      contentType: "text/html",
      body: fragmentBody,
      slot,
    });
  }

  for (const visualIssue of parsed.issues) {
    const slot = visualIssue.slot === null ? null : visualIssue.slot + reservedSlots;
    if (slot === null || slot >= MAX_CODEX_INLINE_VISUALS) {
      replacements.push({ start: visualIssue.start, end: visualIssue.end, replacement: "" });
      continue;
    }
    const file = `inline-visual-${slot + 1}.html`;
    replacements.push({
      start: visualIssue.start,
      end: visualIssue.end,
      replacement: `::rudder-inline-vis{slot="${slot}"}`,
    });
    inlineVisualsV1.push({ version: 1, slot, file, status: "unavailable", reason: visualIssue.code });
  }

  inlineVisualsV1.sort((a, b) => a.slot - b.slot);
  attachments.sort((a, b) =>
    a.source === "rudder_inline_visual" && b.source === "rudder_inline_visual"
      ? a.slot - b.slot
      : 0
  );
  return {
    body: replaceRudderInlineVisualSources(body, replacements),
    attachments,
    inlineVisualsV1,
  };
}
