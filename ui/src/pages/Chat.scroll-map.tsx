import { MarkdownBody } from "@/components/MarkdownBody";
import { LiquidGlassSurface } from "@/components/ui/liquid-glass-surface";
import { cn } from "@/lib/utils";
import type { ChatMessage } from "@rudderhq/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

const CHAT_SCROLL_MAP_MAX_MARKERS = 64;
const CHAT_SCROLL_MAP_PREVIEW_TITLE_LIMIT = 96;
const CHAT_SCROLL_MAP_PREVIEW_SUMMARY_LIMIT = 180;
const CHAT_SCROLL_MAP_RAIL_WIDTH_PX = 16;
const CHAT_SCROLL_MAP_RAIL_GAP_PX = 8;
const CHAT_SCROLL_MAP_CONTENT_SAFE_GAP_PX = 8;
const CHAT_SCROLL_MAP_PREVIEW_WIDTH_PX = 640;
const CHAT_SCROLL_MAP_PREVIEW_VIEWPORT_MARGIN_PX = 16;

export function chatScrollMapPlacement({
  anchorLeft,
  viewportWidth,
  visibleContentLeft,
}: {
  anchorLeft: number;
  viewportWidth: number;
  visibleContentLeft: number;
}) {
  const maxLeft = Math.max(
    CHAT_SCROLL_MAP_PREVIEW_VIEWPORT_MARGIN_PX,
    viewportWidth - CHAT_SCROLL_MAP_RAIL_WIDTH_PX - CHAT_SCROLL_MAP_PREVIEW_VIEWPORT_MARGIN_PX,
  );
  const minLeft = Math.max(CHAT_SCROLL_MAP_PREVIEW_VIEWPORT_MARGIN_PX, anchorLeft);
  const left = Math.round(Math.min(Math.max(anchorLeft, minLeft), maxLeft));
  const railRight = left + CHAT_SCROLL_MAP_RAIL_WIDTH_PX;
  const hasContentClearance = !Number.isFinite(visibleContentLeft)
    || railRight + CHAT_SCROLL_MAP_CONTENT_SAFE_GAP_PX <= visibleContentLeft;
  const hasPreviewClearance = railRight
    + CHAT_SCROLL_MAP_RAIL_GAP_PX
    + CHAT_SCROLL_MAP_PREVIEW_WIDTH_PX
    + CHAT_SCROLL_MAP_PREVIEW_VIEWPORT_MARGIN_PX <= viewportWidth;
  return { left, visible: hasContentClearance && hasPreviewClearance };
}

function isVisibleUserMessage(message: ChatMessage) {
  return message.role === "user"
    && message.kind === "message"
    && !message.supersededAt
    && (message.body.trim().length > 0 || message.attachments.length > 0);
}

export function countScrollMapUserMessages(messages: ChatMessage[]) {
  return messages.filter(isVisibleUserMessage).length;
}

export function chatScrollMapPreviewText(message: ChatMessage) {
  const body = message.body.replace(/\s+/g, " ").trim();
  if (body) return body.length > 140 ? `${body.slice(0, 137)}...` : body;
  if (message.attachments.length > 0) {
    return `${message.attachments.length} attachment${message.attachments.length === 1 ? "" : "s"}`;
  }
  if (message.kind === "issue_proposal") return "Issue proposal";
  if (message.kind === "operation_proposal") return "Operation proposal";
  if (message.kind === "ask_user") return "Question for the operator";
  return "Empty message";
}

function findSafeMarkdownExcerptBoundary(source: string, visibleLimit: number) {
  const scanLimit = Math.min(source.length, Math.max(visibleLimit + 96, visibleLimit * 16));
  let index = 0;
  let visibleLength = 0;
  let unsafe = false;

  while (index < scanLimit && visibleLength < visibleLimit) {
    const imageOffset = source.startsWith("![", index) ? 1 : 0;
    if (source[index + imageOffset] === "[") {
      const labelStart = index + imageOffset + 1;
      const labelClose = source.indexOf("](", labelStart);
      if (labelClose >= labelStart && labelClose < scanLimit) {
        const linkClose = source.indexOf(")", labelClose + 2);
        if (linkClose < 0 || linkClose >= scanLimit) {
          unsafe = true;
          break;
        }
        const labelLength = labelClose - labelStart;
        if (visibleLength + labelLength > visibleLimit) {
          unsafe = visibleLength === 0;
          break;
        }
        visibleLength += labelLength;
        index = linkClose + 1;
        continue;
      }
    }

    if (source[index] === "`") {
      const codeClose = source.indexOf("`", index + 1);
      if (codeClose < 0 || codeClose >= scanLimit) {
        unsafe = true;
        break;
      }
      const codeLength = codeClose - index - 1;
      if (visibleLength + codeLength > visibleLimit) {
        unsafe = visibleLength === 0;
        break;
      }
      visibleLength += codeLength;
      index = codeClose + 1;
      continue;
    }

    visibleLength += 1;
    index += 1;
  }

  return { boundary: index, unsafe };
}

function plainTextMarkdownExcerpt(value: string, limit: number) {
  const boundedSource = value.slice(0, limit + 96);
  const plainText = boundedSource
    .replace(/!?\[([^\]]*)\]\([^)]*(?:\)|$)/gu, "$1")
    .replace(/\b(?:agent|issue):\/\/[^\s)]+/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  const excerpt = plainText.length > limit
    ? `${plainText.slice(0, Math.max(1, limit - 3)).trim()}...`
    : plainText;
  return excerpt.replace(/([\\`*_[\]<>#])/gu, "\\$1");
}

function boundedMarkdownExcerpt(value: string, limit: number) {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= limit) return { end: text.length, markdown: text };
  const { boundary, unsafe } = findSafeMarkdownExcerptBoundary(text, limit - 3);
  const excerpt = text.slice(0, boundary).trim();
  if (unsafe || !excerpt) {
    const end = Math.max(1, Math.min(text.length, limit - 3));
    return { end, markdown: `${plainTextMarkdownExcerpt(text.slice(0, end), limit - 3)}...` };
  }
  return {
    end: boundary,
    markdown: boundary < text.length ? `${excerpt}...` : excerpt,
  };
}

export function chatScrollMapMarkdownExcerpt(value: string, limit: number) {
  return boundedMarkdownExcerpt(value, limit).markdown;
}

function nextAssistantReplyPreview(message: ChatMessage, messages: ChatMessage[]) {
  const index = messages.findIndex((candidate) => candidate.id === message.id);
  const nextMessage = index >= 0 ? messages[index + 1] : null;
  if (!nextMessage || nextMessage.role !== "assistant" || nextMessage.kind !== "message" || nextMessage.supersededAt) {
    return "";
  }
  return chatScrollMapMarkdownExcerpt(nextMessage.body, CHAT_SCROLL_MAP_PREVIEW_SUMMARY_LIMIT);
}

export function chatScrollMapPreviewParts(message: ChatMessage, messages: ChatMessage[]) {
  const body = message.body.replace(/\s+/g, " ").trim();
  const assistantReplyPreview = nextAssistantReplyPreview(message, messages);
  if (body) {
    const title = boundedMarkdownExcerpt(body, CHAT_SCROLL_MAP_PREVIEW_TITLE_LIMIT);
    const summarySource = body.length > title.end ? body.slice(title.end).trim() : "";
    return {
      title: title.markdown,
      summary: assistantReplyPreview || plainTextMarkdownExcerpt(summarySource, CHAT_SCROLL_MAP_PREVIEW_SUMMARY_LIMIT),
    };
  }
  return { title: chatScrollMapPreviewText(message), summary: assistantReplyPreview };
}

function chatScrollMapRoleLabel(message: ChatMessage) {
  if (message.role === "user") return "You";
  if (message.role === "assistant") return "Assistant";
  return "System";
}

export function chatScrollMapVisibleMessages(messages: ChatMessage[]) {
  const visible = messages.filter(isVisibleUserMessage);
  if (visible.length <= CHAT_SCROLL_MAP_MAX_MARKERS) return visible;
  const sampled: ChatMessage[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < CHAT_SCROLL_MAP_MAX_MARKERS; index += 1) {
    const sourceIndex = Math.round((index / (CHAT_SCROLL_MAP_MAX_MARKERS - 1)) * (visible.length - 1));
    const message = visible[sourceIndex];
    if (message && !seen.has(message.id)) {
      seen.add(message.id);
      sampled.push(message);
    }
  }
  return sampled;
}

export function ChatScrollMap({ messages, onJump }: { messages: ChatMessage[]; onJump: (messageId: string) => void }) {
  const railRef = useRef<HTMLDivElement | null>(null);
  const [hoveredMessageId, setHoveredMessageId] = useState<string | null>(null);
  const [previewPosition, setPreviewPosition] = useState<{ left: number; top: number } | null>(null);
  const [railLeft, setRailLeft] = useState<number | null>(null);
  const [railVisible, setRailVisible] = useState(true);
  const mapMessages = useMemo(() => chatScrollMapVisibleMessages(messages), [messages]);
  const hoveredMessage = hoveredMessageId
    ? mapMessages.find((message) => message.id === hoveredMessageId) ?? null
    : null;
  const hoveredPreview = hoveredMessage ? chatScrollMapPreviewParts(hoveredMessage, messages) : null;

  useEffect(() => {
    const rail = railRef.current;
    const shell = rail?.closest<HTMLElement>("[data-testid='chat-messages-shell']");
    if (!rail || !shell) return;

    let frame = 0;
    const updateRailPlacement = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const scrollRegion = shell.closest<HTMLElement>("[data-testid='chat-messages-scroll-region']");
        const anchorBounds = scrollRegion?.getBoundingClientRect() ?? shell.getBoundingClientRect();
        const visibleContentBlocks = Array.from(shell.querySelectorAll<HTMLElement>([
          "[data-testid='chat-user-message-bubble']",
          "[data-testid='chat-inline-message-editor']",
          "[data-testid='chat-long-message-body']",
        ].join(",")));
        const visibleContentLeft = visibleContentBlocks.reduce((left, element) => {
          const bounds = element.getBoundingClientRect();
          if (bounds.bottom <= 0 || bounds.top >= window.innerHeight || bounds.width <= 0) return left;
          return Math.min(left, bounds.left);
        }, Number.POSITIVE_INFINITY);
        const placement = chatScrollMapPlacement({
          anchorLeft: anchorBounds.left,
          viewportWidth: window.innerWidth,
          visibleContentLeft,
        });
        setRailVisible((current) => current === placement.visible ? current : placement.visible);
        if (!placement.visible) {
          setHoveredMessageId(null);
          setPreviewPosition(null);
        }
        setRailLeft((current) => current === placement.left ? current : placement.left);
      });
    };

    updateRailPlacement();
    const scrollRegion = shell.closest<HTMLElement>("[data-testid='chat-messages-scroll-region']");
    window.addEventListener("resize", updateRailPlacement);
    scrollRegion?.addEventListener("scroll", updateRailPlacement, { passive: true });
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateRailPlacement);
    resizeObserver?.observe(shell);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("resize", updateRailPlacement);
      scrollRegion?.removeEventListener("scroll", updateRailPlacement);
      resizeObserver?.disconnect();
    };
  }, [mapMessages]);

  const updatePreviewPosition = useCallback((target: HTMLElement) => {
    const bounds = target.getBoundingClientRect();
    setPreviewPosition({
      left: Math.min(
        bounds.right + CHAT_SCROLL_MAP_RAIL_GAP_PX,
        Math.max(
          CHAT_SCROLL_MAP_PREVIEW_VIEWPORT_MARGIN_PX,
          window.innerWidth - CHAT_SCROLL_MAP_PREVIEW_WIDTH_PX - CHAT_SCROLL_MAP_PREVIEW_VIEWPORT_MARGIN_PX,
        ),
      ),
      top: Math.min(Math.max(bounds.top + bounds.height / 2, 80), window.innerHeight - 80),
    });
  }, []);
  const showPreview = Boolean(railVisible && hoveredMessage && hoveredPreview && previewPosition);
  if (mapMessages.length === 0) return null;

  return (
    <>
      <div
        ref={railRef}
        data-testid="chat-scroll-map"
        aria-label="Conversation message map"
        className={cn(
          "pointer-events-none fixed top-1/2 z-20 hidden w-4 -translate-y-1/2 flex-col items-start gap-0.5 md:flex",
          (railLeft === null || !railVisible) && "invisible",
        )}
        style={{ left: railLeft ?? 0 }}
      >
        {mapMessages.map((message) => (
          <button
            key={message.id}
            type="button"
            data-testid={`chat-scroll-map-marker-${message.id}`}
            aria-label={`Jump to ${chatScrollMapRoleLabel(message)} message: ${chatScrollMapPreviewText(message)}`}
            className={cn(
              "pointer-events-auto relative z-10 h-2.5 w-4 rounded-[var(--radius-xs)] border border-transparent bg-transparent px-0 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
              "before:absolute before:right-0 before:top-1/2 before:h-0.5 before:w-2.5 before:-translate-y-1/2 before:rounded-full before:bg-[color:color-mix(in_oklab,var(--muted-foreground)_36%,transparent)] before:transition-all",
              "hover:before:w-4 hover:before:bg-[color:var(--foreground)]",
            )}
            onMouseEnter={(event) => {
              setHoveredMessageId(message.id);
              updatePreviewPosition(event.currentTarget);
            }}
            onFocus={(event) => {
              setHoveredMessageId(message.id);
              updatePreviewPosition(event.currentTarget);
            }}
            onMouseLeave={() => {
              setHoveredMessageId((current) => current === message.id ? null : current);
              setPreviewPosition(null);
            }}
            onBlur={() => {
              setHoveredMessageId((current) => current === message.id ? null : current);
              setPreviewPosition(null);
            }}
            onClick={() => onJump(message.id)}
          />
        ))}
      </div>
      {showPreview ? createPortal(
        <div
          data-testid="chat-scroll-map-preview"
          className="chat-scroll-map-preview liquid-glass-host pointer-events-none fixed z-50 w-[40rem] max-w-[calc(100vw-2rem)] -translate-y-1/2 rounded-[18px] border border-white/10 bg-[rgba(42,42,42,0.94)] px-4 py-3.5 text-left shadow-[0_24px_70px_-34px_rgb(0_0_0/0.88)] backdrop-blur-xl"
          style={{ left: previewPosition!.left, top: previewPosition!.top }}
        >
          <LiquidGlassSurface variant="preview" />
          <MarkdownBody className="chat-scroll-map-preview-title line-clamp-1 text-[15px] font-semibold leading-6 [&_*]:text-current [&_a]:pointer-events-none [&_a]:align-baseline [&_code]:bg-white/10 [&_p]:inline">
            {hoveredPreview?.title ?? ""}
          </MarkdownBody>
          {hoveredPreview?.summary ? (
            <MarkdownBody className="chat-scroll-map-preview-summary mt-1.5 line-clamp-3 text-[15px] leading-6 [&_*]:text-current [&_a]:pointer-events-none [&_a]:align-baseline [&_code]:bg-white/10 [&_p]:inline">
              {hoveredPreview.summary}
            </MarkdownBody>
          ) : null}
        </div>,
        document.body,
      ) : null}
    </>
  );
}
