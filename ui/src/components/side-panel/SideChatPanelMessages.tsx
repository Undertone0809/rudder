import type { TranscriptEntry } from "@/agent-runtimes";
import type { MarkdownLinkClickHandler } from "@/components/MarkdownBody";
import type { MarkdownSkillReferencePreview } from "@/components/SkillReferenceToken";
import { TranscriptContinuationControls } from "@/components/transcript/TranscriptContinuationControls";
import {
  chatTranscriptEntriesForMessage,
  isAgentRunTranscriptActiveStatus,
  useAgentRunTranscripts,
  useLegacyChatTranscripts,
} from "@/components/transcript/useAgentRunTranscripts";
import type { ChatStreamDraft } from "@/context/ChatGenerationContext";
import {
  AssistantDraftItem,
  ChatMessageItem,
  OptimisticUserDraftItem,
  StreamTranscriptItem,
} from "@/pages/Chat.messages";
import type { ApprovalAction } from "@/pages/Chat.parts";
import type {
  Agent,
  ChatConversation,
  ChatInlineAnnotation,
  ChatMessage,
  ChatOperationProposalDecisionAction,
} from "@rudderhq/shared";
import { useMemo } from "react";

type SideChatPanelMessagesProps = {
  conversation: ChatConversation | null;
  transcriptConversationId: string | null;
  messages: ChatMessage[];
  stream: ChatStreamDraft | null;
  showOptimisticUserMessage: boolean;
  agents: Agent[] | undefined;
  decisionNotesByMessageId: Record<string, string>;
  isMessageMutationAllowed: (messageId: string) => boolean;
  actionPending: boolean;
  onDecisionNoteChange: (messageId: string, value: string) => void;
  onApprovalAction: (approvalId: string, action: ApprovalAction, messageId: string) => void;
  onResolveOperationProposal: (
    messageId: string,
    action: ChatOperationProposalDecisionAction,
    decisionNote: string,
  ) => void;
  onConvertToIssue: (message: ChatMessage) => void;
  onCopyMessageText: (text: string) => void | Promise<void>;
  onEditDraftOnly: (body: string) => void;
  onOpenFile: (targetPath: string, label: string) => void;
  onMarkdownLinkClick: MarkdownLinkClickHandler;
  onSelectResponseAnnotation: (annotation: ChatInlineAnnotation, ordinal: number) => void;
  skillReferences: MarkdownSkillReferencePreview[];
};

export function SideChatPanelMessages({
  conversation,
  transcriptConversationId,
  messages,
  stream,
  showOptimisticUserMessage,
  agents,
  decisionNotesByMessageId,
  isMessageMutationAllowed,
  actionPending,
  onDecisionNoteChange,
  onApprovalAction,
  onResolveOperationProposal,
  onConvertToIssue,
  onCopyMessageText,
  onEditDraftOnly,
  onOpenFile,
  onMarkdownLinkClick,
  onSelectResponseAnnotation,
  skillReferences,
}: SideChatPanelMessagesProps) {
  const agentRunTranscriptTargets = useMemo(
    () => messages.flatMap((message) => message.runId
      ? [{ runId: message.runId, active: isAgentRunTranscriptActiveStatus(message.status) }]
      : []),
    [messages],
  );
  const { transcriptByRun, transcriptStateByRun, transcriptNavigationByRun } = useAgentRunTranscripts(
    agentRunTranscriptTargets,
  );
  const legacyTranscriptByMessageId = useLegacyChatTranscripts(transcriptConversationId, messages);

  return (
    <div className="flex min-h-[12rem] flex-col gap-5" data-testid="side-chat-messages">
      {conversation ? messages.map((message) => {
        const transcript = chatTranscriptEntriesForMessage(
          message,
          Object.fromEntries(legacyTranscriptByMessageId) as Readonly<Record<string, TranscriptEntry[]>>,
          transcriptByRun,
        );
        const messageMutationAllowed = isMessageMutationAllowed(message.id);
        return (
          <div key={message.id}>
            {message.role === "assistant" && transcript.length > 0 ? (
              <StreamTranscriptItem
                entries={transcript}
                state={message.status}
                generationTerminalReason={message.generationTerminalReason}
                streamStartedAt={new Date(message.createdAt)}
                streamEndedAt={new Date(message.updatedAt)}
                assistantMessageBody={message.body}
                showDeveloperDiagnostics={false}
                onOpenFile={onOpenFile}
              />
            ) : null}
            {message.role === "assistant" && message.runId ? (
              <TranscriptContinuationControls
                navigation={transcriptNavigationByRun.get(message.runId)}
                state={transcriptStateByRun.get(message.runId)}
              />
            ) : null}
            <ChatMessageItem
              conversation={conversation}
              message={message}
              agents={agents}
              decisionNote={decisionNotesByMessageId[message.id] ?? ""}
              onDecisionNoteChange={(value) => {
                if (messageMutationAllowed) onDecisionNoteChange(message.id, value);
              }}
              decisionNoteMentions={[]}
              onDecisionNoteMentionQueryChange={() => {}}
              onDecisionNoteInlineTokenClick={() => {}}
              onApprovalAction={onApprovalAction}
              onResolveOperationProposal={onResolveOperationProposal}
              onConvertToIssue={onConvertToIssue}
              actionPending={actionPending || !messageMutationAllowed}
              onCopyMessageText={onCopyMessageText}
              onOpenFile={(targetPath) => onOpenFile(
                targetPath,
                targetPath.split(/[\\/]/u).at(-1) || targetPath,
              )}
              onMarkdownLinkClick={onMarkdownLinkClick}
              onSelectResponseAnnotation={onSelectResponseAnnotation}
              skillReferences={skillReferences}
            />
          </div>
        );
      }) : null}
      {stream && conversation ? (
        <div className="flex flex-col gap-5" data-testid="side-chat-streaming-reply">
          {showOptimisticUserMessage ? (
            <OptimisticUserDraftItem
              body={stream.userBody}
              files={stream.userFiles}
              createdAt={stream.userCreatedAt}
              onCopyMessageText={onCopyMessageText}
              onEditDraftOnly={onEditDraftOnly}
              skillReferences={skillReferences}
              onMarkdownLinkClick={onMarkdownLinkClick}
            />
          ) : null}
          <StreamTranscriptItem
            entries={stream.transcript}
            state={stream.state}
            streamStartedAt={stream.createdAt}
            assistantMessageBody={stream.body}
            showDeveloperDiagnostics={false}
            onOpenFile={onOpenFile}
          />
          <AssistantDraftItem
            body={stream.body}
            createdAt={stream.createdAt}
            state={stream.state}
            replyingAgentId={stream.replyingAgentId}
            conversation={conversation}
            agents={agents}
            onCopyMessageText={onCopyMessageText}
            skillReferences={skillReferences}
            onMarkdownLinkClick={onMarkdownLinkClick}
          />
        </div>
      ) : null}
    </div>
  );
}
