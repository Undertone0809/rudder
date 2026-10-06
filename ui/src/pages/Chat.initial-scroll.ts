import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

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

type ChatStreamScrollLease = {
  conversationId: string;
  streamKey: string;
  following: boolean;
};

export function useChatStreamBottomScroll(input: {
  conversationId: string | null;
  streamKey: string | null;
  scrollElementRef: RefObject<HTMLDivElement | null>;
  scrollToBottom: (element: HTMLDivElement) => void;
}) {
  const leaseRef = useRef<ChatStreamScrollLease | null>(null);

  useLayoutEffect(() => {
    const { conversationId, streamKey, scrollElementRef, scrollToBottom } = input;
    const scrollElement = scrollElementRef.current;
    const previousLease = leaseRef.current;

    if (!conversationId || !scrollElement) {
      leaseRef.current = null;
      return;
    }

    if (!streamKey) {
      leaseRef.current = null;
      if (previousLease?.conversationId === conversationId && previousLease.following) {
        scrollToBottom(scrollElement);
      }
      return;
    }

    const lease = previousLease?.conversationId === conversationId
      && previousLease.streamKey === streamKey
      ? previousLease
      : { conversationId, streamKey, following: true };
    leaseRef.current = lease;
    let previousHeight = scrollElement.scrollHeight;
    let frame = requestAnimationFrame(() => {
      if (lease.following) scrollToBottom(scrollElement);
      previousHeight = scrollElement.scrollHeight;
    });
    let userIntentFrame: number | null = null;

    const isAtBottom = () => (
      scrollElement.scrollTop + scrollElement.clientHeight >= scrollElement.scrollHeight - 24
    );
    const pauseUnlessAtBottom = () => {
      lease.following = false;
      if (userIntentFrame !== null) cancelAnimationFrame(userIntentFrame);
      userIntentFrame = requestAnimationFrame(() => {
        userIntentFrame = null;
        if (isAtBottom()) lease.following = true;
      });
    };
    const resumeAtBottom = () => {
      if (isAtBottom()) lease.following = true;
    };
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => {
        const wasAtBottom = scrollElement.scrollTop + scrollElement.clientHeight >= previousHeight - 24;
        previousHeight = scrollElement.scrollHeight;
        if (!lease.following || !wasAtBottom) return;
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => scrollToBottom(scrollElement));
      });
    const content = scrollElement.firstElementChild;
    if (content) observer?.observe(content);

    scrollElement.addEventListener("wheel", pauseUnlessAtBottom, { passive: true });
    scrollElement.addEventListener("touchstart", pauseUnlessAtBottom, { passive: true });
    scrollElement.addEventListener("pointerdown", pauseUnlessAtBottom, { passive: true });
    scrollElement.addEventListener("scroll", resumeAtBottom, { passive: true });

    return () => {
      observer?.disconnect();
      cancelAnimationFrame(frame);
      if (userIntentFrame !== null) cancelAnimationFrame(userIntentFrame);
      scrollElement.removeEventListener("wheel", pauseUnlessAtBottom);
      scrollElement.removeEventListener("touchstart", pauseUnlessAtBottom);
      scrollElement.removeEventListener("pointerdown", pauseUnlessAtBottom);
      scrollElement.removeEventListener("scroll", resumeAtBottom);
    };
  }, [input.conversationId, input.scrollElementRef, input.scrollToBottom, input.streamKey]);
}
