import { useEffect, type RefObject } from "react";

export function useChatInitialBottomScroll(input: {
  conversationId: string | null;
  loading: boolean;
  targetMessageId: string | null;
  scrollElementRef: RefObject<HTMLDivElement | null>;
  scrolledConversationRef: RefObject<string | null>;
  scrollToBottom: (element: HTMLDivElement) => void;
}) {
  useEffect(() => {
    const { conversationId, loading, targetMessageId, scrollElementRef, scrolledConversationRef, scrollToBottom } = input;
    if (!conversationId || loading || scrolledConversationRef.current === conversationId) return;
    scrolledConversationRef.current = conversationId;
    const scrollElement = scrollElementRef.current;
    if (!scrollElement) return;
    let active = !targetMessageId;
    let frame = requestAnimationFrame(() => scrollToBottom(scrollElement));
    const content = scrollElement.firstElementChild;
    let previousHeight = scrollElement.scrollHeight;
    const observer = active && content && typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => {
        if (!active) return;
        const wasAtBottom = scrollElement.scrollTop + scrollElement.clientHeight >= previousHeight - 24;
        previousHeight = scrollElement.scrollHeight;
        if (wasAtBottom) {
          cancelAnimationFrame(frame);
          frame = requestAnimationFrame(() => scrollToBottom(scrollElement));
        }
      })
      : null;
    if (content) observer?.observe(content);
    const stop = () => { active = false; observer?.disconnect(); };
    scrollElement.addEventListener("wheel", stop, { once: true });
    scrollElement.addEventListener("touchstart", stop, { once: true });
    scrollElement.addEventListener("pointerdown", stop, { once: true });
    const timeout = setTimeout(stop, 3_000);
    return () => {
      stop();
      clearTimeout(timeout);
      cancelAnimationFrame(frame);
      scrollElement.removeEventListener("wheel", stop);
      scrollElement.removeEventListener("touchstart", stop);
      scrollElement.removeEventListener("pointerdown", stop);
    };
  }, [input.conversationId, input.loading, input.targetMessageId, input.scrollElementRef, input.scrolledConversationRef, input.scrollToBottom]);
}
