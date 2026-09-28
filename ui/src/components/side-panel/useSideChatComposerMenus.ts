import { composerMenuPositionForAnchor } from "@/pages/Chat.parts";
import { useCallback, useEffect, type CSSProperties, type Dispatch, type RefObject, type SetStateAction } from "react";

type SideChatComposerMenuInput = {
  active: boolean;
  agentMenuOpen: boolean;
  skillMenuOpen: boolean;
  setAgentMenuOpen: Dispatch<SetStateAction<boolean>>;
  setSkillMenuOpen: Dispatch<SetStateAction<boolean>>;
  setSkillSearchQuery: Dispatch<SetStateAction<string>>;
  setComposerMenuPosition: Dispatch<SetStateAction<CSSProperties | null>>;
  runtimeSelectorRef: RefObject<HTMLButtonElement | null>;
  composerSurfaceRef: RefObject<HTMLDivElement | null>;
  composerContextMenuRef: RefObject<HTMLDivElement | null>;
  skillButtonRef: RefObject<HTMLButtonElement | null>;
  skillSearchInputRef: RefObject<HTMLInputElement | null>;
};

export function useSideChatComposerMenus({
  active, agentMenuOpen, skillMenuOpen, setAgentMenuOpen, setSkillMenuOpen,
  setSkillSearchQuery, setComposerMenuPosition, runtimeSelectorRef,
  composerSurfaceRef, composerContextMenuRef, skillButtonRef, skillSearchInputRef,
}: SideChatComposerMenuInput) {
  const composerContextMenuOpen = agentMenuOpen || skillMenuOpen;
  const closeComposerContextMenus = useCallback(() => {
    setAgentMenuOpen(false);
    setSkillMenuOpen(false);
    setSkillSearchQuery("");
  }, []);
  useEffect(() => {
    if (active) return;
    closeComposerContextMenus();
    setComposerMenuPosition(null);
  }, [active, closeComposerContextMenus]);
  const openComposerContextMenu = useCallback((kind: "agent" | "skill") => {
    const anchor = kind === "agent"
      ? runtimeSelectorRef.current ?? composerSurfaceRef.current
      : composerSurfaceRef.current;
    if (anchor) setComposerMenuPosition(composerMenuPositionForAnchor(anchor));
    setAgentMenuOpen(kind === "agent");
    setSkillMenuOpen(kind === "skill");
    if (kind !== "skill") setSkillSearchQuery("");
  }, [runtimeSelectorRef]);

  useEffect(() => {
    if (!composerContextMenuOpen) {
      setComposerMenuPosition(null);
      return;
    }
    const updatePosition = () => {
      const anchor = agentMenuOpen
        ? runtimeSelectorRef.current ?? composerSurfaceRef.current
        : composerSurfaceRef.current;
      if (!anchor) return;
      setComposerMenuPosition(composerMenuPositionForAnchor(anchor));
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [agentMenuOpen, composerContextMenuOpen, runtimeSelectorRef]);

  useEffect(() => {
    if (!composerContextMenuOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      const node = event.target;
      if (!(node instanceof Node)) return;
      if (node instanceof Element && node.closest("[data-chat-runtime-submenu]")) return;
      if (composerContextMenuRef.current?.contains(node)) return;
      if (runtimeSelectorRef.current?.contains(node)) return;
      closeComposerContextMenus();
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const restoreRuntimeFocus = agentMenuOpen;
      const restoreSkillsFocus = skillMenuOpen;
      closeComposerContextMenus();
      if (restoreRuntimeFocus) {
        requestAnimationFrame(() => runtimeSelectorRef.current?.focus());
      } else if (restoreSkillsFocus) {
        requestAnimationFrame(() => skillButtonRef.current?.focus());
      }
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [
    agentMenuOpen,
    closeComposerContextMenus,
    composerContextMenuOpen,
    runtimeSelectorRef,
    skillMenuOpen,
  ]);
  useEffect(() => {
    if (!agentMenuOpen) return;
    requestAnimationFrame(() => {
      composerContextMenuRef.current
        ?.querySelector<HTMLButtonElement>("[data-chat-composer-menu-item]")
        ?.focus();
    });
  }, [agentMenuOpen]);
  useEffect(() => {
    if (!skillMenuOpen) return;
    requestAnimationFrame(() => skillSearchInputRef.current?.focus());
  }, [skillMenuOpen]);
  return { composerContextMenuOpen, closeComposerContextMenus, openComposerContextMenu };
}
