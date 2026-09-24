import { useMemo } from "react";
import type { TranscriptEntry } from "../../agent-runtimes";
import { renderTranscriptBlock } from "./RunTranscriptView.blocks";
import {
  TranscriptAgentInspection,
  TranscriptAnnotationSourceContext,
  TranscriptDensity,
  TranscriptMarkdownLinkClickHandler,
  TranscriptRunAnnotationContext,
  TranscriptSentAnnotationContext,
  TranscriptSkillTarget,
  isInternalTranscriptLifecycleEntry,
  transcriptBlockStableKey,
} from "./RunTranscriptView.common";
import { normalizeChatTranscriptTurns } from "./RunTranscriptView.normalize";
import {
  TranscriptChatTurn,
  TranscriptTextContext,
  filterChatAssistantTranscriptEntries,
} from "./RunTranscriptView.chat";

const CHAT_READING_COLUMN_CLASS = "w-full min-w-0 max-w-3xl px-1";
const CHAT_FULL_COLUMN_CLASS = "w-full min-w-0";

export function TranscriptChatTimeline({
  entries,
  density,
  streaming,
  collapseStdout,
  thinkingClassName,
  hideAssistantMessages,
  hiddenAssistantMessageText,
  localizeText = (text) => text,
  showDeveloperDiagnostics,
  onMarkdownLinkClick,
  onOpenFile,
  onOpenSkill,
  canOpenSkill,
  agentInspections,
  onOpenAgent,
  annotationSource,
  sentAnnotationContext,
  runAnnotationContext,
}: {
  entries: TranscriptEntry[];
  density: TranscriptDensity;
  streaming: boolean;
  collapseStdout: boolean;
  thinkingClassName?: string;
  hideAssistantMessages: boolean;
  hiddenAssistantMessageText?: string | null;
  localizeText?: (text: string) => string;
  showDeveloperDiagnostics: boolean;
  onMarkdownLinkClick?: TranscriptMarkdownLinkClickHandler;
  onOpenFile?: (targetPath: string, label: string) => void;
  onOpenSkill?: (target: TranscriptSkillTarget) => void;
  canOpenSkill?: (target: TranscriptSkillTarget) => boolean;
  agentInspections: Map<string, TranscriptAgentInspection>;
  onOpenAgent?: (agent: TranscriptAgentInspection) => void;
  annotationSource?: TranscriptAnnotationSourceContext;
  sentAnnotationContext?: TranscriptSentAnnotationContext;
  runAnnotationContext?: TranscriptRunAnnotationContext;
}) {
  const timelineEntries = useMemo(
    () => filterChatAssistantTranscriptEntries(entries, {
      hideAssistantMessages,
      hiddenAssistantMessageText,
      streaming,
      preserveLifecycleBoundaries: true,
    }),
    [entries, hideAssistantMessages, hiddenAssistantMessageText, streaming],
  );
  const { preludeBlocks, turns } = useMemo(
    () => normalizeChatTranscriptTurns(timelineEntries, streaming, { showDeveloperDiagnostics }),
    [timelineEntries, streaming, showDeveloperDiagnostics],
  );

  return (
    <TranscriptTextContext.Provider value={localizeText}>
      <div className="w-full min-w-0 space-y-3">
        {preludeBlocks.map((block, index) => {
          const fullWidth = block.type === "message" && block.source === "steer";
          return (
            <div
              key={transcriptBlockStableKey(block, index)}
              data-transcript-chat-column={fullWidth ? "full" : "reading"}
              className={fullWidth ? CHAT_FULL_COLUMN_CLASS : CHAT_READING_COLUMN_CLASS}
            >
              {renderTranscriptBlock({
                block,
                index,
                density,
                presentation: "chat",
                collapseStdout,
                thinkingClassName,
                onMarkdownLinkClick,
                annotationSource,
                sentAnnotationContext,
                runAnnotationContext,
                localizeText,
              })}
            </div>
          );
        })}
        {turns.map((turn) => (
          <TranscriptChatTurn
            key={turn.key}
            turn={turn}
            density={density}
            thinkingClassName={thinkingClassName}
            onMarkdownLinkClick={onMarkdownLinkClick}
            onOpenFile={onOpenFile}
            onOpenSkill={onOpenSkill}
            canOpenSkill={canOpenSkill}
            agentInspections={agentInspections}
            onOpenAgent={onOpenAgent}
            annotationSource={annotationSource}
            sentAnnotationContext={sentAnnotationContext}
            runAnnotationContext={runAnnotationContext}
          />
        ))}
      </div>
    </TranscriptTextContext.Provider>
  );
}
