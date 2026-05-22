import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { ArrowDown, ArrowUp, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  activateIssueFindMatch,
  clearIssueFindHighlights,
  highlightIssueFindMatches,
  isEditableIssueFindTarget,
  isIssueFindShortcut,
} from "@/lib/issue-detail-find";

type IssueDetailFindProps = {
  rootRef: RefObject<HTMLElement | null>;
  disabled?: boolean;
  refreshKey?: string;
};

function hasBlockingOverlay() {
  if (typeof document === "undefined") return false;
  return Boolean(
    document.querySelector("[role='dialog']") ||
    document.querySelector("[data-radix-popper-content-wrapper]"),
  );
}

function isPlainEscape(event: KeyboardEvent) {
  return event.key === "Escape" &&
    !event.defaultPrevented &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey;
}

export function IssueDetailFind({ rootRef, disabled = false, refreshKey }: IssueDetailFindProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matchCount, setMatchCount] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const matchesRef = useRef<HTMLElement[]>([]);
  const activeIndexRef = useRef(0);
  const lastQueryRef = useRef("");
  const skipEditableRootRef = useRef<HTMLElement | null>(null);

  const focusInput = useCallback(() => {
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, []);

  const closeFind = useCallback(() => {
    const root = rootRef.current;
    if (root) {
      clearIssueFindHighlights(root);
    }
    matchesRef.current = [];
    activeIndexRef.current = 0;
    lastQueryRef.current = "";
    skipEditableRootRef.current = null;
    setOpen(false);
    setQuery("");
    setMatchCount(0);
    setActiveIndex(0);
  }, [rootRef]);

  const moveToMatch = useCallback((direction: 1 | -1) => {
    const matches = matchesRef.current;
    if (matches.length === 0) {
      activeIndexRef.current = 0;
      setActiveIndex(0);
      return;
    }

    const nextIndex = (activeIndexRef.current + direction + matches.length) % matches.length;
    activeIndexRef.current = nextIndex;
    setActiveIndex(nextIndex);
    const active = activateIssueFindMatch(matches, nextIndex);
    active?.scrollIntoView?.({ block: "center", inline: "nearest", behavior: "smooth" });
  }, []);

  useEffect(() => {
    if (disabled && open) {
      closeFind();
    }
  }, [closeFind, disabled, open]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (disabled) return;

      if (isIssueFindShortcut(event)) {
        if (hasBlockingOverlay()) return;
        const target = event.target instanceof HTMLElement ? event.target : null;
        skipEditableRootRef.current = target?.closest("input, textarea, select, [contenteditable='true']") ?? null;
        event.preventDefault();
        setOpen(true);
        focusInput();
        return;
      }

      if (!open || !isPlainEscape(event)) return;

      const target = event.target instanceof HTMLElement ? event.target : null;
      const targetInFind = Boolean(target?.closest("[data-issue-find-ui]"));
      if (!targetInFind && isEditableIssueFindTarget(event.target)) return;

      event.preventDefault();
      closeFind();
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [closeFind, disabled, focusInput, open]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || !open) return;

    const nextMatches = highlightIssueFindMatches(root, query, {
      skipElement: skipEditableRootRef.current,
    });
    matchesRef.current = nextMatches;
    setMatchCount(nextMatches.length);

    const trimmedQuery = query.trim();
    const shouldResetActive = lastQueryRef.current !== trimmedQuery;
    lastQueryRef.current = trimmedQuery;
    const nextActiveIndex = nextMatches.length === 0
      ? 0
      : shouldResetActive
        ? 0
        : Math.min(activeIndexRef.current, nextMatches.length - 1);

    activeIndexRef.current = nextActiveIndex;
    setActiveIndex(nextActiveIndex);
    const active = activateIssueFindMatch(nextMatches, nextActiveIndex);
    if (trimmedQuery && active) {
      active.scrollIntoView?.({ block: "center", inline: "nearest", behavior: "smooth" });
    }

    return () => {
      clearIssueFindHighlights(root);
      matchesRef.current = [];
    };
  }, [open, query, refreshKey, rootRef]);

  useEffect(() => {
    return () => {
      const root = rootRef.current;
      if (root) {
        clearIssueFindHighlights(root);
      }
    };
  }, [rootRef]);

  if (!open) return null;

  const countLabel = matchCount === 0 ? "0 of 0" : `${activeIndex + 1} of ${matchCount}`;

  return (
    <div
      data-issue-find-ui
      role="search"
      aria-label="Find in issue"
      className="fixed right-4 top-4 z-50 flex w-[min(420px,calc(100vw-2rem))] items-center gap-1 rounded-md border border-border bg-popover p-1.5 text-popover-foreground shadow-md"
    >
      <Search className="ml-1 h-4 w-4 shrink-0 text-muted-foreground" />
      <Input
        ref={inputRef}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            moveToMatch(event.shiftKey ? -1 : 1);
            return;
          }
          if (event.key === "ArrowDown") {
            event.preventDefault();
            moveToMatch(1);
            return;
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            moveToMatch(-1);
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            closeFind();
          }
        }}
        className="h-7 min-w-0 flex-1 border-0 bg-transparent px-1 text-sm shadow-none focus-visible:ring-0"
        placeholder="Find"
        aria-label="Find in issue"
      />
      <span className="min-w-14 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
        {countLabel}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Previous match"
        disabled={matchCount === 0}
        onClick={() => moveToMatch(-1)}
      >
        <ArrowUp className="h-3.5 w-3.5" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Next match"
        disabled={matchCount === 0}
        onClick={() => moveToMatch(1)}
      >
        <ArrowDown className="h-3.5 w-3.5" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Close find"
        onClick={closeFind}
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
