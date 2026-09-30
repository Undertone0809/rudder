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
  ChatMessageItem,
  OptimisticUserDraftItem,
  StreamTranscriptItem,
} from "@/pages/Chat.messages";
import {
  chatAssistantMessageRowKey,
  chatAssistantStreamRowKey,
  chatStreamDraftAssistantMessage,
  chatStreamingAssistantBody,
  type ChatAssistantRowIdentityMap,
} from "@/pages/Chat.timeline";
import { activeChatStreamTimelineInsertionIndex } from "@/lib/chat-stream-state";
import type { ApprovalAction } from "@/pages/Chat.parts";
import type {
  Agent,
  ChatConversation,
  ChatInlineAnnotation,
  ChatMessage,
  ChatOperationProposalDecisionAction,
} from "@rudderhq/shared";
import { useEffect, useMemo, useState } from "react";

type SideChatPanelMessagesProps = {
  conversation: ChatConversation | null;
  transcriptConversationId: string | null;
  messages: ChatMessage[];
  stream: ChatStreamDraft | null;
  assistantRowIdentities: Readonly<ChatAssistantRowIdentityMap>;
  activeAssistantMessageId: string | null;
  showOptimisticUserMessage: boolean;
  requireFinalAnswerPhase: boolean;
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
  assistantRowIdentities,
  activeAssistantMessageId,
  showOptimisticUserMessage,
  requireFinalAnswerPhase,
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
  const streamHasMessage = Boolean(
    activeAssistantMessageId && messages.some((message) => message.id === activeAssistantMessageId),
  );
  const fallbackAssistantBody = stream && conversation
    ? chatStreamingAssistantBody(stream.transcript, stream.body, requireFinalAnswerPhase)
    : "";
  const fallbackAssistantMessage = stream && conversation
    ? chatStreamDraftAssistantMessage(stream, conversation, fallbackAssistantBody)
    : null;
  const displayedMessages = useMemo(() => {
    if (!stream || !fallbackAssistantMessage || streamHasMessage) return messages;
    const nextMessages = [...messages];
    nextMessages.splice(
      activeChatStreamTimelineInsertionIndex(messages, stream),
      0,
      fallbackAssistantMessage,
    );
    return nextMessages;
  }, [fallbackAssistantMessage, messages, stream, streamHasMessage]);
  const streamingMessage = stream
    ? displayedMessages.find((message) => (
      message.role === "assistant"
      && message.status === "streaming"
      && (message.id === fallbackAssistantMessage?.id || message.id === activeAssistantMessageId)
    ))
    : null;
  const streamingAssistantRowKey = stream && streamingMessage
    ? chatAssistantMessageRowKey(
      streamingMessage,
      stream,
      activeAssistantMessageId,
      assistantRowIdentities,
    )
    : null;
  const [processOpenByRowKey, setProcessOpenByRowKey] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!streamingAssistantRowKey) return;
    setProcessOpenByRowKey((current) => (
      current[streamingAssistantRowKey] === undefined
        ? { ...current, [streamingAssistantRowKey]: true }
        : current
    ));
  }, [streamingAssistantRowKey]);

  const updateProcessOpen = (rowKey: string, open: boolean) => {
    setProcessOpenByRowKey((current) => (
      current[rowKey] === open
        ? current
        : { ...current, [rowKey]: open }
    ));
  };

  return (
    <div className="flex min-h-[12rem] flex-col gap-5" data-testid="side-chat-messages">
      {conversation ? displayedMessages.map((message) => {
        const isDraftStreamMessage = message.id === fallbackAssistantMessage?.id;
        const messageStream = stream && (
          isDraftStreamMessage
          || (message.role === "assistant" && message.id === activeAssistantMessageId)
        ) ? stream : null;
        const messageRowKey = chatAssistantMessageRowKey(
          message,
          messageStream ?? stream,
          activeAssistantMessageId,
          assistantRowIdentities,
        );
        const transcript = chatTranscriptEntriesForMessage(
          message,
          Object.fromEntries(legacyTranscriptByMessageId) as Readonly<Record<string, TranscriptEntry[]>>,
          transcriptByRun,
        );
        const streamedAssistantBody = messageStream && message.status === "streaming"
          ? chatStreamingAssistantBody(
            messageStream.transcript,
            messageStream.body,
            requireFinalAnswerPhase,
          )
          : undefined;
        const displayedMessage = streamedAssistantBody === undefined
          ? message
          : { ...message, body: streamedAssistantBody };
        const messageMutationAllowed = isMessageMutationAllowed(message.id);
        const isStreamingAssistant = message.role === "assistant"
          && messageStream !== null
          && message.status === "streaming";
        return (
          <div
            key={messageRowKey}
            {...(messageStream && message.status === "streaming"
              ? { "data-testid": "side-chat-streaming-reply" }
              : {})}
          >
            {messageStream && showOptimisticUserMessage ? (
              <OptimisticUserDraftItem
                body={messageStream.userBody}
                files={messageStream.userFiles}
                createdAt={messageStream.userCreatedAt}
                onCopyMessageText={onCopyMessageText}
                onEditDraftOnly={onEditDraftOnly}
                skillReferences={skillReferences}
                onMarkdownLinkClick={onMarkdownLinkClick}
              />
            ) : null}
            {message.role === "assistant" && messageStream && message.status === "streaming" ? (
              <StreamTranscriptItem
                key={`stream-transcript:${chatAssistantStreamRowKey(messageStream)}`}
                entries={messageStream.transcript}
                state={messageStream.state}
                open={processOpenByRowKey[messageRowKey] ?? isStreamingAssistant}
                onOpenChange={(open) => updateProcessOpen(messageRowKey, open)}
                streamStartedAt={messageStream.createdAt}
                assistantMessageBody={messageStream.body}
                showDeveloperDiagnostics={false}
                onOpenFile={onOpenFile}
              />
            ) : message.role === "assistant" && transcript.length > 0 ? (
              <StreamTranscriptItem
                entries={transcript}
                state={message.status}
                open={processOpenByRowKey[messageRowKey] ?? false}
                onOpenChange={(open) => updateProcessOpen(messageRowKey, open)}
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
              key={messageRowKey}
              conversation={conversation}
              message={displayedMessage}
              streamedAssistantBody={streamedAssistantBody}
              draftPresentation={Boolean(messageStream && message.status === "streaming")}
              draftState={messageStream && message.status === "streaming" ? messageStream.state : undefined}
              onEditDraftOnly={messageStream && message.status === "streaming" ? onEditDraftOnly : undefined}
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
    </div>
  );
}
