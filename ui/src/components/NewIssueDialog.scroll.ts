import { useScrollbarActivityRef } from "../hooks/useScrollbarActivityRef";

const DESCRIPTION_SCROLL_CLASS_NAME =
  "scrollbar-auto-hide min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-contain border-t border-border/60 px-4 pb-2 pt-3";

export function useNewIssueDescriptionScrollProps() {
  const descriptionScrollRef = useScrollbarActivityRef();
  const agentDescriptionScrollRef = useScrollbarActivityRef();

  return {
    description: {
      "data-slot": "new-issue-description",
      ref: descriptionScrollRef,
      className: DESCRIPTION_SCROLL_CLASS_NAME,
    },
    agentDescription: {
      "data-slot": "agent-issue-description",
      ref: agentDescriptionScrollRef,
      className: DESCRIPTION_SCROLL_CLASS_NAME,
    },
  };
}
