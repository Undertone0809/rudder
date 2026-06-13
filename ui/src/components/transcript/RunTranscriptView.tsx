import { useCallback, useMemo } from "react";
import { useOptionalToast } from "../../context/ToastContext";
import { readDesktopShell } from "../../lib/desktop-shell";
import { cn } from "../../lib/utils";
import { renderTranscriptBlock } from "./RunTranscriptView.blocks";
import { TranscriptChatTimeline } from "./RunTranscriptView.chat";
import { filterRenderableTranscriptEntries, resolveTranscriptLocalFileTarget, RunTranscriptViewProps, shouldHandlePlainClick, TranscriptMarkdownLinkClickHandler } from "./RunTranscriptView.common";
import { RawTranscriptView, TranscriptDetailTimeline } from "./RunTranscriptView.detail";
import { normalizeTranscript } from "./RunTranscriptView.normalize";

export { resolveTranscriptLocalFileTarget } from "./RunTranscriptView.common";
export type { TranscriptDensity, TranscriptMode, TranscriptPresentation } from "./RunTranscriptView.common";
export { normalizeTranscript } from "./RunTranscriptView.normalize";

export function RunTranscriptView({
  entries,
  mode = "nice",
  density = "comfortable",
  limit,
  streaming = false,
  collapseStdout = false,
  emptyMessage = "No transcript yet.",
  className,
  thinkingClassName,
  presentation = "default",
  showDeveloperDiagnostics = false,
  hideAssistantMessages = false,
  hiddenAssistantMessageText = null,
}: RunTranscriptViewProps) {
  const toastContext = useOptionalToast();
  const handleMarkdownLinkClick = useCallback<TranscriptMarkdownLinkClickHandler>(({ event, href }) => {
    if (!shouldHandlePlainClick(event)) return;

    const targetPath = resolveTranscriptLocalFileTarget(href);
    if (!targetPath) return;

    event.preventDefault();
    event.stopPropagation();

    const desktopShell = readDesktopShell();
    if (!desktopShell) {
      toastContext?.pushToast({
        title: "Open from Desktop",
        body: "Local transcript file links can only be opened from the Rudder Desktop app.",
        tone: "warn",
      });
      return true;
    }

    void desktopShell.openPath(targetPath).catch((error) => {
      toastContext?.pushToast({
        title: "Failed to open file",
        body: error instanceof Error ? error.message : `Could not open ${targetPath}.`,
        tone: "error",
      });
    });
    return true;
  }, [toastContext]);
  const renderableEntries = useMemo(
    () => filterRenderableTranscriptEntries(entries, { showDeveloperDiagnostics }),
    [entries, showDeveloperDiagnostics],
  );
  const blocks = useMemo(
    () => normalizeTranscript(renderableEntries, streaming, { showDeveloperDiagnostics }),
    [renderableEntries, streaming, showDeveloperDiagnostics],
  );
  const visibleBlocks = limit ? blocks.slice(-limit) : blocks;
  const visibleEntries = limit ? renderableEntries.slice(-limit) : renderableEntries;

  if (renderableEntries.length === 0) {
    return (
      <div className={cn("rounded-2xl border border-dashed border-border/70 bg-background/40 p-4 text-sm text-muted-foreground", className)}>
        {emptyMessage}
      </div>
    );
  }

  if (mode === "raw") {
    return (
      <div className={className}>
        <RawTranscriptView entries={visibleEntries} density={density} />
      </div>
    );
  }

  if (presentation === "detail") {
    return (
      <div className={cn("space-y-4", className)}>
        <TranscriptDetailTimeline
          entries={visibleEntries}
          density={density}
          streaming={streaming}
          thinkingClassName={thinkingClassName}
          showDeveloperDiagnostics={showDeveloperDiagnostics}
          onMarkdownLinkClick={handleMarkdownLinkClick}
        />
      </div>
    );
  }

  if (presentation === "chat") {
    return (
      <div className={className}>
        <TranscriptChatTimeline
          entries={visibleEntries}
          density={density}
          streaming={streaming}
          collapseStdout={collapseStdout}
          thinkingClassName={thinkingClassName}
          hideAssistantMessages={hideAssistantMessages}
          hiddenAssistantMessageText={hiddenAssistantMessageText}
          showDeveloperDiagnostics={showDeveloperDiagnostics}
          onMarkdownLinkClick={handleMarkdownLinkClick}
        />
      </div>
    );
  }

  return (
    <div className={cn("space-y-3", className)}>
      {visibleBlocks.map((block, index) => (
        <div
          key={`${block.type}-${block.ts}-${index}`}
          className={cn(index === visibleBlocks.length - 1 && streaming && "animate-in fade-in slide-in-from-bottom-1 duration-300")}
        >
          {renderTranscriptBlock({
            block,
            index,
            density,
            presentation,
            collapseStdout,
            thinkingClassName,
            onMarkdownLinkClick: handleMarkdownLinkClick,
          })}
        </div>
      ))}
    </div>
  );
}
