import type { TranscriptEntry } from "@/agent-runtimes";
import type {
  TranscriptAgentDirectoryEntry,
  TranscriptAgentInspection,
  TranscriptRunAnnotationContext,
  TranscriptSkillTarget,
} from "@/components/transcript/RunTranscriptView";
import { RunTranscriptView } from "@/components/transcript/RunTranscriptView";
import {
  filterRenderableTranscriptEntries,
} from "@/components/transcript/RunTranscriptView.common";
import { normalizeTranscript } from "@/components/transcript/RunTranscriptView.normalize";
import type { ChatStreamDraftState } from "@/context/ChatGenerationContext";
import { formatChatProcessDuration, lastTranscriptAtMs } from "@/lib/chat-process-duration";
import { mergeNativeSteerTranscriptEntries } from "@/lib/chat-stream-state";
import { cn } from "@/lib/utils";
import type {
  ChatInlineAnnotation,
  ChatInlineAnnotationInput,
  ChatMessage,
} from "@rudderhq/shared";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { displayedChatMessageState } from "./Chat.parts";
import { chatProcessTranscriptEntries } from "./Chat.timeline";

export function StreamTranscriptItem({
  entries,
  steerMessages = [],
  state,
  generationTerminalReason,
  streamStartedAt,
  streamEndedAt,
  assistantMessageBody,
  showDeveloperDiagnostics,
  open,
  defaultOpen = false,
  onOpenChange,
  onOpenFile,
  onOpenSkill,
  canOpenSkill,
  onOpenAgent,
  agentDirectory,
  annotationSource,
  runAnnotationContext,
  sentAnnotationContext,
  localizeText = (text) => text,
}: {
  entries: TranscriptEntry[];
  steerMessages?: ChatMessage[];
  state: ChatStreamDraftState | ChatMessage["status"];
  generationTerminalReason?: string | null;
  streamStartedAt: Date;
  streamEndedAt?: Date | null;
  assistantMessageBody?: string | null;
  showDeveloperDiagnostics?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  onOpenFile?: (targetPath: string, label: string) => void;
  onOpenSkill?: (target: TranscriptSkillTarget) => void;
  canOpenSkill?: (target: TranscriptSkillTarget) => boolean;
  onOpenAgent?: (agent: TranscriptAgentInspection) => void;
  agentDirectory?: TranscriptAgentDirectoryEntry[];
  runAnnotationContext?: TranscriptRunAnnotationContext;
  annotationSource?: {
    sourceConversationId: string;
    sourceMessageId: string;
    annotations?: Array<ChatInlineAnnotationInput & { ordinal?: number }>;
    onActivateAnnotation?: (
      annotationId: string,
      anchor: HTMLButtonElement,
    ) => void;
  };
  sentAnnotationContext?: {
    onSelect?: (annotation: ChatInlineAnnotation, ordinal: number) => void;
    onExpandedChange?: (
      annotations: ChatInlineAnnotation[],
      expanded: boolean,
    ) => void;
    unlocatableAnnotationId?: string | null;
  };
  localizeText?: (text: string) => string;
}) {
  const timelineEntries = useMemo(
    () => chatProcessTranscriptEntries(mergeNativeSteerTranscriptEntries(entries, steerMessages)),
    [entries, steerMessages],
  );
  const streamingActive = state === "streaming" || state === "tool_busy" || state === "finalizing";
  const waitingForNetwork = state === "waiting_for_network";
  const hasSteerInterjection = steerMessages.length > 0;
  const renderableProcessEntries = useMemo(
    () => filterRenderableTranscriptEntries(timelineEntries, { presentation: "chat" }),
    [timelineEntries],
  );
  const processBlocks = useMemo(
    () => normalizeTranscript(renderableProcessEntries, streamingActive, { hideUserMessages: true }),
    [renderableProcessEntries, streamingActive],
  );
  const [internalProcessOpen, setInternalProcessOpen] = useState(
    () => streamingActive || defaultOpen || hasSteerInterjection,
  );
  const processOpen = open ?? internalProcessOpen;
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!streamingActive || processBlocks.length === 0) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, [processBlocks.length, streamingActive]);

  useEffect(() => {
    if (defaultOpen || hasSteerInterjection) setInternalProcessOpen(true);
  }, [defaultOpen, hasSteerInterjection]);

  const durationMs = useMemo(() => {
    const start = streamStartedAt.getTime();
    const explicitEnd = streamEndedAt?.getTime() ?? 0;
    const end = streamingActive ? Date.now() : Math.max(lastTranscriptAtMs(timelineEntries), explicitEnd);
    return Math.max(0, end - start);
  }, [streamStartedAt, streamEndedAt, streamingActive, timelineEntries, tick]);

  const hasHiddenStderrHistory = timelineEntries.some((entry) => entry.kind === "stderr");
  if (processBlocks.length === 0 && !hasHiddenStderrHistory) return null;

  const displayedState = displayedChatMessageState({ role: "assistant", status: state as ChatMessage["status"], generationTerminalReason });
  const statusHint =
    displayedState === "failed"
      ? localizeText("Stopped with errors")
      : displayedState === "stopped"
        ? localizeText("Stopped")
        : "";

  const showBody = processOpen || streamingActive;

  return (
    <div data-testid="chat-transcript-item" className="flex min-w-0 justify-start transition-all duration-200">
      <div className="w-full min-w-0 py-1">
        <div className="w-full min-w-0 max-w-3xl px-1">
          <div className="flex items-center gap-3">
            <div className="h-px min-w-[1rem] flex-1 bg-border/45" aria-hidden />
            <button
              type="button"
              className={cn(
                "flex max-w-[min(100%,90%)] shrink-0 items-center gap-1.5 text-[12px] text-muted-foreground transition-colors",
                streamingActive ? "cursor-default" : "hover:text-foreground",
              )}
              disabled={streamingActive}
              onClick={() => {
                if (!streamingActive) {
                  const next = !processOpen;
                  if (open === undefined) setInternalProcessOpen(next);
                  onOpenChange?.(next);
                }
              }}
              aria-expanded={showBody}
            >
              {streamingActive ? (
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
              ) : null}
              <span className="whitespace-nowrap">
                {localizeText(`${streamingActive ? "Working" : waitingForNetwork ? "Waiting" : "Worked"} for ${formatChatProcessDuration(durationMs)}`)}
              </span>
              {statusHint ? (
                <span className="truncate text-amber-700/90 dark:text-amber-400/85">· {statusHint}</span>
              ) : null}
              {streamingActive ? (
                <ChevronDown className="h-4 w-4 shrink-0 opacity-60" aria-hidden />
              ) : showBody ? (
                <ChevronDown className="h-4 w-4 shrink-0 opacity-60" aria-hidden />
              ) : (
                <ChevronRight className="h-4 w-4 shrink-0 opacity-60" aria-hidden />
              )}
            </button>
            <div className="h-px min-w-[1rem] flex-1 bg-border/45" aria-hidden />
          </div>
        </div>
        <div
          className={cn("mt-3", !showBody && "hidden")}
          aria-hidden={!showBody}
          data-testid="chat-transcript-content"
        >
          <RunTranscriptView
            entries={timelineEntries}
            mode="nice"
            streaming={streamingActive}
            collapseStdout
            presentation="chat"
            showDeveloperDiagnostics={showDeveloperDiagnostics}
            hiddenAssistantMessageText={assistantMessageBody}
            localizeText={localizeText}
            onOpenFile={onOpenFile}
            onOpenSkill={onOpenSkill}
            canOpenSkill={canOpenSkill}
            onOpenAgent={onOpenAgent}
            agentDirectory={agentDirectory}
            annotationSource={annotationSource}
            runAnnotationContext={runAnnotationContext}
            sentAnnotationContext={sentAnnotationContext}
          />
        </div>
      </div>
    </div>
  );
}
