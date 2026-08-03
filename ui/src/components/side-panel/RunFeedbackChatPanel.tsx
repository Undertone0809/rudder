import { agentsApi } from "@/api/agents";
import { chatsApi } from "@/api/chats";
import { projectsApi } from "@/api/projects";
import {
  ChatComposerEditor,
  ChatComposerSendButton,
  ChatComposerSurface,
  ChatComposerToolbar,
} from "@/components/chat/ChatComposer";
import {
  DraftResponseAnnotationsPopover,
  ResponseAnnotationEditor,
} from "@/components/chat/ResponseAnnotations";
import { useToast } from "@/context/ToastContext";
import {
  canSubmitChatResponseAnnotations,
  chatResponseAnnotationsForDraft,
  createChatResponseAnnotationState,
  responseAnnotationReducer,
  serializeChatResponseAnnotations,
  validateChatResponseAnnotationReplacement,
} from "@/lib/chat-response-annotations";
import { queryKeys } from "@/lib/queryKeys";
import { sidePanelTargetKey, type SidePanelTarget } from "@/lib/side-panel-targets";
import type {
  ChatConversation,
  ChatInlineAnnotationInput,
  ChatMessage,
  Project,
} from "@rudderhq/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquare, Paperclip } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";

type RunFeedbackTarget = Extract<SidePanelTarget, { kind: "run_feedback_chat" }>;

function makeId() {
  return globalThis.crypto?.randomUUID?.() ?? `annotation-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function messageBody(message: ChatMessage) {
  return message.body?.trim() || (message.role === "user" ? "Annotation-only feedback" : "");
}

export function RunFeedbackChatPanel({
  organizationId,
  target,
  onReplaceTarget,
}: {
  organizationId: string;
  target: RunFeedbackTarget;
  onReplaceTarget: (key: string, target: SidePanelTarget) => void;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [draft, setDraft] = useState(target.body ?? "");
  const [projectId, setProjectId] = useState<string | null>(target.projectId ?? null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamBody, setStreamBody] = useState("");
  const [annotationState, dispatchAnnotation] = useReducer(
    responseAnnotationReducer,
    target.inlineAnnotations ?? [],
    createChatResponseAnnotationState,
  );
  const [annotationsExpanded, setAnnotationsExpanded] = useState(false);
  const [editingAnnotationId, setEditingAnnotationId] = useState<string | null>(null);
  const annotationChipRef = useRef<HTMLButtonElement | null>(null);
  const editingAnchorRef = useRef<HTMLButtonElement | null>(null);
  const mutationKeyRef = useRef(target.clientMutationId || makeId());

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        `rudder.run-feedback-draft:${organizationId}:${target.agentId}`,
        JSON.stringify(target),
      );
    } catch {
      // Ignore restricted storage environments; the Side Panel state remains authoritative.
    }
  }, [organizationId, target]);

  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(organizationId),
    queryFn: () => agentsApi.list(organizationId),
  });
  const projectsQuery = useQuery({
    queryKey: queryKeys.projects.list(organizationId),
    queryFn: () => projectsApi.list(organizationId),
  });
  const conversationQuery = useQuery({
    queryKey: queryKeys.chats.detail(organizationId, target.conversationId ?? "__run-feedback-draft__"),
    queryFn: () => chatsApi.get(target.conversationId!),
    enabled: Boolean(target.conversationId),
  });
  const messagesQuery = useQuery({
    queryKey: queryKeys.chats.messages(organizationId, target.conversationId ?? "__run-feedback-draft__"),
    queryFn: () => chatsApi.listMessages(organizationId, target.conversationId!, { includeTranscript: true }),
    enabled: Boolean(target.conversationId),
  });

  useEffect(() => {
    if (messagesQuery.data) setMessages(messagesQuery.data);
  }, [messagesQuery.data]);
  useEffect(() => {
    setDraft(target.body ?? "");
  }, [target.body]);
  useEffect(() => {
    const targetAnnotations = target.inlineAnnotations ?? [];
    const localAnnotations = chatResponseAnnotationsForDraft(annotationState);
    const persistedTargetAnnotations = targetAnnotations.map((annotation) => {
      const {
        attachmentFileIndexes: _attachmentFileIndexes,
        ordinal: _ordinal,
        ...persistable
      } = annotation as ChatInlineAnnotationInput & { ordinal?: number };
      return persistable;
    });
    if (JSON.stringify(persistedTargetAnnotations) === JSON.stringify(localAnnotations)) return;
    dispatchAnnotation({ type: "reset", annotations: targetAnnotations });
    setAnnotationsExpanded(targetAnnotations.length > 0);
  }, [annotationState, target.inlineAnnotations]);
  useEffect(() => {
    setProjectId(target.projectId ?? null);
  }, [target.projectId]);

  const selectedAgent = useMemo(
    () => (agentsQuery.data ?? []).find((agent) => agent.id === target.agentId) ?? null,
    [agentsQuery.data, target.agentId],
  );
  const selectedProject = useMemo(
    () => (projectsQuery.data ?? []).find((project) => project.id === projectId) ?? null,
    [projectId, projectsQuery.data],
  );
  const projectLocked = Boolean(
    target.projectLocked
    || target.conversationId
    || messages.some((message) => message.role === "user"),
  );
  const annotationCount = annotationState.annotations.length;
  const canSend = canSubmitChatResponseAnnotations(draft, annotationState);

  const updateTarget = useCallback((patch: Partial<RunFeedbackTarget>) => {
    onReplaceTarget(sidePanelTargetKey(target), { ...target, ...patch });
  }, [onReplaceTarget, target]);

  const handleProjectChange = (value: string) => {
    if (projectLocked) return;
    const next = value || null;
    setProjectId(next);
    updateTarget({ projectId: next });
  };

  const handleAnnotate = useCallback(async (input: {
    sourceRunId: string;
    sourceAgentId: string;
    blockId: string;
    blockType: string;
    text: string;
  }) => {
    if (!input.text.trim()) return;
    const hash = await sha256(input.text);
    const annotation: ChatInlineAnnotationInput = {
      id: makeId(),
      selectedText: input.text,
      comment: null,
      sourceHash: hash,
      surface: "agent_run_transcript",
      sourceRunId: input.sourceRunId,
      sourceAgentId: input.sourceAgentId,
      anchorKind: "transition",
      sourceEntryId: input.blockId,
      sourceMemberIds: [input.blockId],
      attachmentFileIndexes: [],
    };
    dispatchAnnotation({ type: "add", annotation });
    updateTarget({
      body: draft,
      inlineAnnotations: [...annotationState.annotations, annotation],
    });
    setAnnotationsExpanded(true);
  }, [annotationState.annotations, draft, updateTarget]);

  const handleSend = async () => {
    if (sending || !canSend) return;
    const body = draft.trim();
    const serialized = serializeChatResponseAnnotations(annotationState);
    setSending(true);
    setError(null);
    setStreamBody("");
    try {
      if (target.conversationId) {
        await chatsApi.sendMessageStream(target.conversationId, body, {
          files: serialized.files,
          inlineAnnotations: serialized.inlineAnnotations,
          onEvent: async (event) => {
            if (event.type === "ack") {
              setMessages((current) => [...current, event.userMessage]);
              dispatchAnnotation({ type: "clear" });
              updateTarget({ body: "", inlineAnnotations: [] });
            }
            if (event.type === "assistant_delta") setStreamBody((current) => current + event.delta);
            if (event.type === "final") setMessages((current) => [...current, ...event.messages]);
            if (event.type === "error") throw new Error(event.error);
          },
        });
      } else {
        await chatsApi.sendFirstMessageStream(organizationId, body, {
          preferredAgentId: target.agentId,
          issueCreationMode: "manual_approval",
          planMode: false,
          modelOverride: null,
          effortOverride: null,
          contextLinks: projectId ? [{ entityType: "project", entityId: projectId }] : [],
          clientMutationId: mutationKeyRef.current,
          files: serialized.files,
          inlineAnnotations: serialized.inlineAnnotations,
          onEvent: async (event) => {
            if (event.type === "ack") {
              setMessages((current) => [...current, event.userMessage]);
              dispatchAnnotation({ type: "clear" });
              setAnnotationsExpanded(false);
              const nextTarget = {
                ...target,
                conversationId: event.userMessage.conversationId,
                projectLocked: true,
                projectId,
                body: "",
                inlineAnnotations: [],
              } satisfies RunFeedbackTarget;
              updateTarget(nextTarget);
              try {
                window.localStorage.setItem(
                  `rudder.run-feedback-draft:${organizationId}:${target.agentId}`,
                  JSON.stringify(nextTarget),
                );
              } catch {
                // Ignore restricted storage environments; the Side Panel state remains authoritative.
              }
            }
            if (event.type === "assistant_delta") setStreamBody((current) => current + event.delta);
            if (event.type === "final") setMessages((current) => [...current, ...event.messages]);
            if (event.type === "error") throw new Error(event.error);
          },
        });
      }
      if (target.conversationId) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: queryKeys.chats.detail(organizationId, target.conversationId) }),
          queryClient.invalidateQueries({ queryKey: queryKeys.chats.messages(organizationId, target.conversationId) }),
        ]);
      }
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "Could not send feedback.");
    } finally {
      setSending(false);
    }
  };

  const conversation = conversationQuery.data as ChatConversation | undefined;
  const visibleMessages = [...messages, ...(streamBody ? [{ id: "stream", role: "assistant", body: streamBody } as ChatMessage] : [])];
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="run-feedback-chat-panel">
      <div className="scrollbar-auto-hide min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
          <div className="flex items-center gap-2 border-b border-border/70 pb-3">
            <MessageSquare className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">Run feedback</div>
              <div className="truncate text-xs text-muted-foreground">{selectedAgent?.name ?? target.agentId}</div>
            </div>
          </div>
          {conversation ? <div className="text-xs text-muted-foreground">{conversation.title}</div> : null}
          {visibleMessages.map((message) => (
            <div key={message.id} className={`rounded-lg border px-3 py-2 text-sm ${message.role === "user" ? "ml-6 bg-muted/30" : "mr-6"}`}>
              <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">{message.role}</div>
              <div className="whitespace-pre-wrap break-words">{messageBody(message)}</div>
            </div>
          ))}
        </div>
      </div>
      {error ? <div role="alert" className="px-4 pb-2 text-sm text-destructive">{error}</div> : null}
      <div className="shrink-0 px-4 pb-4">
        <ChatComposerSurface className="mx-auto max-w-3xl" testId="run-feedback-composer">
          {annotationCount > 0 ? (
            <div className="mb-3 flex flex-col items-start gap-2">
              <DraftResponseAnnotationsPopover
                annotations={annotationState.annotations}
                pendingFilesByAnnotationId={annotationState.pendingFilesByAnnotationId}
                open={annotationsExpanded}
                buttonRef={annotationChipRef}
                onOpenChange={(open) => {
                  setAnnotationsExpanded(open);
                  if (open) setEditingAnnotationId(null);
                }}
                onClear={() => {
                  dispatchAnnotation({ type: "clear" });
                  updateTarget({ inlineAnnotations: [] });
                }}
                onEdit={(annotation) => {
                  editingAnchorRef.current = annotationChipRef.current;
                  setEditingAnnotationId(annotation.id);
                }}
                onDelete={(id) => {
                  dispatchAnnotation({ type: "delete", id });
                  updateTarget({ inlineAnnotations: annotationState.annotations.filter((item) => item.id !== id) });
                }}
              />
              {editingAnnotationId ? (() => {
                const annotation = annotationState.annotations.find((item) => item.id === editingAnnotationId);
                if (!annotation) return null;
                const anchor = editingAnchorRef.current;
                return (
                  <ResponseAnnotationEditor
                    annotation={annotation}
                    ordinal={annotation.ordinal}
                    pendingFiles={annotationState.pendingFilesByAnnotationId[annotation.id] ?? []}
                    showSelectedTextContext
                    anchorRect={anchor?.getBoundingClientRect() ?? null}
                    getAnchorRect={() => anchor?.getBoundingClientRect() ?? null}
                    boundaryRect={null}
                    getBoundaryRect={() => null}
                    returnFocusRef={editingAnchorRef}
                    validateSave={(changes) => validateChatResponseAnnotationReplacement(annotationState, annotation.id, {
                      comment: changes.comment,
                      attachmentIds: changes.attachmentIds,
                      files: changes.pendingFiles,
                    })}
                onSave={({ comment, pendingFiles, attachmentIds }) => {
                  dispatchAnnotation({ type: "replaceDraft", id: annotation.id, comment, attachmentIds, files: pendingFiles });
                  updateTarget({
                    inlineAnnotations: annotationState.annotations.map((item) => (
                      item.id === annotation.id
                        ? { ...item, comment, attachmentIds }
                        : item
                    )),
                  });
                  setEditingAnnotationId(null);
                }}
                onCancel={() => setEditingAnnotationId(null)}
                onDelete={() => {
                  dispatchAnnotation({ type: "delete", id: annotation.id });
                  updateTarget({ inlineAnnotations: annotationState.annotations.filter((item) => item.id !== annotation.id) });
                  setEditingAnnotationId(null);
                }}
                  />
                );
              })() : null}
            </div>
          ) : null}
          <ChatComposerEditor
            value={draft}
            onChange={(value) => {
              setDraft(value);
              updateTarget({ body: value });
            }}
            placeholder="Add context for this feedback…"
            onSubmit={() => void handleSend()}
          />
          <ChatComposerToolbar
            actions={<ChatComposerSendButton mode={sending ? "sending" : "send"} ariaLabel={sending ? "Sending feedback" : "Send feedback"} disabled={!canSend || sending} onClick={() => void handleSend()} />}
          >
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" title={selectedProject?.name ?? "No project"}>
              <Paperclip className="h-3.5 w-3.5 opacity-60" aria-hidden="true" />
              <select
                aria-label="Project"
                value={projectId ?? ""}
                disabled={projectLocked || projectsQuery.isPending}
                onChange={(event) => handleProjectChange(event.currentTarget.value)}
                className="max-w-[10rem] bg-transparent text-xs outline-none disabled:cursor-not-allowed disabled:opacity-60"
              >
                <option value="">No project</option>
                {(projectsQuery.data ?? []).map((project: Project) => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select>
            </span>
          </ChatComposerToolbar>
        </ChatComposerSurface>
      </div>
    </div>
  );
}
