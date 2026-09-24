import type { AgentRuntimeType, ChatContextLink, ChatConversation } from "@rudderhq/shared";
import { AGENT_RUNTIME_TYPES, shortRefFor } from "@rudderhq/shared";
import type { Db } from "@rudderhq/db";
import { discoverAgentRuntimeModels, findServerAdapter } from "../agent-runtimes/index.js";
import { agentRunContextService } from "./agent-run-context.js";
import { agentService } from "./agents.js";
import {
  asRecord,
  CHAT_UNSUPPORTED_ADAPTER_TYPES,
  chatExecutionConfig,
  ChatAssistantStreamError,
  linkedGoalIdForChat,
  linkedIssueIdsForChat,
  linkedProjectIdForChat,
  modelLabel,
  safeTrim,
  summarizeRuntimeSkills,
  type ResolvedChatRuntimeSource,
  unavailableAgentDescriptor,
  unconfiguredDescriptor,
} from "./chat-assistant.helpers.js";
import { enrichConversationRuntimeDescriptors } from "./chat-assistant.runtime-batch.js";
import { applyChatRuntimeOverrides, chatEffortFromConfig } from "./chat-assistant.runtime-overrides.js";

export function isAgentRuntimeType(value: string): value is AgentRuntimeType {
  return (AGENT_RUNTIME_TYPES as readonly string[]).includes(value);
}

export function chatRuntimePreparationStreamError(error: unknown) {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const safeContextSource = rawMessage.replace(/[?#][^\s]*/g, "");
  const skillMatch = safeContextSource.match(
    /\borganization skill\s+["'`]?([a-z0-9][a-z0-9._-]{0,127})/i,
  );
  const skill = skillMatch?.[1]?.replace(/[.,:;]+$/, "") || null;
  const file = /(?:^|[/\\])SKILL\.md(?=$|[\s"'`:),])/i.test(safeContextSource)
    ? "SKILL.md"
    : null;
  const context = skill
    ? `organization skill "${skill}"${file ? ` file "${file}"` : ""}`
    : file
      ? `runtime file "${file}"`
      : "the configured runtime skills and files";
  const userMessage = skill
    ? `Could not prepare organization skill "${skill}"${file ? ` file "${file}"` : ""}. Check that its installed files are available, then retry.`
    : file
      ? `Could not prepare runtime file "${file}". Check that the file is available, then retry.`
      : "Could not prepare the configured runtime skills or files. Check the agent runtime and skill configuration, then retry.";
  return new ChatAssistantStreamError(
    `Chat runtime preparation failed for ${context}`,
    "",
    [],
    {
      errorCode: "chat_runtime_preparation_failed",
      userMessage,
      retryable: true,
      failurePhase: "runtime_boot",
      action: "retry",
    },
  );
}

export function chatRuntimeAvailabilityStreamError(errorMessage?: string | null) {
  const candidate = errorMessage?.trim() ?? "";
  const safeKnownMessage = (
    candidate === "Choose a chat agent before sending messages."
    || candidate === "The selected chat agent is unavailable. Choose another agent before sending messages."
    || candidate === "The selected agent runtime is not registered with Rudder Chat."
    || candidate === "The current user has not configured a chat model yet."
    || /^Unknown chat adapter type: [a-z0-9_-]+$/i.test(candidate)
  )
    ? candidate
    : "The assistant runtime is not configured or available. Check the selected agent runtime, then retry.";
  return new ChatAssistantStreamError(
    safeKnownMessage,
    "",
    [],
    {
      errorCode: "chat_runtime_boot_failed",
      userMessage: safeKnownMessage,
      retryable: false,
      failurePhase: "runtime_boot",
      action: "repair_runtime",
    },
  );
}

export function createChatAssistantRuntimeResolution(
  db: Db,
) {
  const agentsSvc = agentService(db);
  const runContextSvc = agentRunContextService(db);
  async function resolveChatInvocation(input: {
    conversation: Pick<ChatConversation, "id" | "orgId" | "preferredAgentId" | "modelOverride" | "effortOverride" | "primaryIssueId" | "contextLinks" | "planMode">;
    contextLinks: ChatContextLink[];
    prepareExecutionContext?: boolean;
    materializeManagedInstructions?: boolean;
    materializeMissingRuntimeSkills?: boolean;
    agentIdSnapshot?: string | null;
    modelSnapshot?: string | null;
    effortSnapshot?: string | null;
  }) {
    const runtimeSource = await resolveConversationRuntime(
      input.conversation,
      {
        prepareRuntimeConfig: input.prepareExecutionContext !== false,
        materializeManagedInstructions: input.materializeManagedInstructions,
        materializeMissingRuntimeSkills: input.materializeMissingRuntimeSkills,
        ...(input.agentIdSnapshot !== undefined ? { agentIdSnapshot: input.agentIdSnapshot } : {}),
        ...(input.modelSnapshot !== undefined ? { modelSnapshot: input.modelSnapshot } : {}),
        ...(input.effortSnapshot !== undefined ? { effortSnapshot: input.effortSnapshot } : {}),
      },
    );
    if (!runtimeSource.descriptor.available) {
      return {
        runtimeSource,
        adapter: null,
        config: null,
        linkedIssueIds: [] as string[],
        linkedProjectId: null as string | null,
        linkedGoalId: null as string | null,
        resolvedWorkspace: null,
        sceneContext: null,
        availabilityError: runtimeSource.descriptor.error ?? "Chat assistant is not configured",
      };
    }
    if (!runtimeSource.agentRuntimeType || !runtimeSource.agentRuntimeConfig || !runtimeSource.runtimeAgent) {
      return {
        runtimeSource,
        adapter: null,
        config: null,
        linkedIssueIds: [] as string[],
        linkedProjectId: null as string | null,
        linkedGoalId: null as string | null,
        resolvedWorkspace: null,
        sceneContext: null,
        availabilityError: runtimeSource.descriptor.error ?? "Chat runtime is not configured",
      };
    }

    const adapter = findServerAdapter(runtimeSource.agentRuntimeType);
    if (!adapter) {
      return {
        runtimeSource,
        adapter: null,
        config: null,
        linkedIssueIds: [] as string[],
        linkedProjectId: null as string | null,
        linkedGoalId: null as string | null,
        resolvedWorkspace: null,
        sceneContext: null,
        availabilityError: `Unknown chat adapter type: ${runtimeSource.agentRuntimeType}`,
      };
    }

    const config = chatExecutionConfig(
      input.conversation,
      runtimeSource.agentRuntimeType,
      runtimeSource.agentRuntimeConfig,
    );
    const linkedIssueIds = linkedIssueIdsForChat(input.conversation, input.contextLinks);
    const linkedProjectId = linkedProjectIdForChat(input.contextLinks);
    const linkedGoalId = linkedGoalIdForChat(input.contextLinks);
    if (input.prepareExecutionContext === false) {
      return {
        runtimeSource,
        adapter,
        config,
        linkedIssueIds,
        linkedProjectId,
        linkedGoalId,
        resolvedWorkspace: null,
        sceneContext: null,
        availabilityError: null,
      };
    }
    const resolvedWorkspace = await runContextSvc.resolveWorkspaceForRun(
      runtimeSource.runtimeAgent,
      {
        issueId: input.conversation.primaryIssueId ?? linkedIssueIds[0] ?? null,
        projectId: linkedProjectId,
      },
      null,
    );

    const sceneContext = await runContextSvc.buildSceneContext({
      scene: "chat",
      agent: runtimeSource.runtimeAgent,
      resolvedWorkspace,
      runtimeConfig: config,
      issueId: input.conversation.primaryIssueId ?? linkedIssueIds[0] ?? null,
      chatConversationId: input.conversation.id,
    });

    return {
      runtimeSource,
      adapter,
      config,
      linkedIssueIds,
      linkedProjectId,
      linkedGoalId,
      resolvedWorkspace,
      sceneContext,
      availabilityError: null,
    };
  }

  async function resolveAgentRuntime(
    orgId: string,
    agentId: string,
    options?: {
      prepareRuntimeConfig?: boolean;
      materializeManagedInstructions?: boolean;
      materializeMissingRuntimeSkills?: boolean;
    },
  ): Promise<ResolvedChatRuntimeSource | null> {
    const agent = await agentsSvc.getInternalById(agentId);
    if (!agent || agent.orgId !== orgId || agent.status === "terminated") {
      return {
        descriptor: unavailableAgentDescriptor({
          sourceLabel: "Selected agent",
          runtimeAgentId: null,
          agentRuntimeType: null,
          model: null,
          error: "The selected chat agent is unavailable. Choose another agent before sending messages.",
        }),
        runtimeAgent: null,
        agentRuntimeType: null,
        agentRuntimeConfig: null,
        runtimeSkills: [],
      };
    }

    const agentAdapterType = agent.agentRuntimeType as AgentRuntimeType;
    const agentAdapterConfig = asRecord(agent.agentRuntimeConfig) ?? {};
    const registeredAdapter = findServerAdapter(agentAdapterType);

    if (!registeredAdapter) {
      return {
        descriptor: unavailableAgentDescriptor({
          sourceLabel: agent.name,
          runtimeAgentId: agent.id,
          agentRuntimeType: agentAdapterType,
          model: modelLabel(agentAdapterConfig) ?? null,
          error: "The selected agent runtime is not registered with Rudder Chat.",
        }),
        runtimeAgent: {
          id: agent.id,
          orgId: agent.orgId,
          name: agent.name,
          agentRuntimeType: agentAdapterType,
          agentRuntimeConfig: agentAdapterConfig,
        },
        agentRuntimeType: agentAdapterType,
        agentRuntimeConfig: null,
        runtimeSkills: [],
      };
    }

    if (CHAT_UNSUPPORTED_ADAPTER_TYPES.has(agentAdapterType)) {
      return {
        descriptor: unavailableAgentDescriptor({
          sourceLabel: agent.name,
          runtimeAgentId: agent.id,
          agentRuntimeType: agentAdapterType,
          model: modelLabel(agentAdapterConfig) ?? null,
          error: "The current user has not configured a chat model yet.",
        }),
        runtimeAgent: {
          id: agent.id,
          orgId: agent.orgId,
          name: agent.name,
          agentRuntimeType: agentAdapterType,
          agentRuntimeConfig: agentAdapterConfig,
        },
        agentRuntimeType: agentAdapterType,
        agentRuntimeConfig: null,
        runtimeSkills: [],
      };
    }

    const shouldPrepareRuntimeConfig = options?.prepareRuntimeConfig !== false;
    const preparedAgentRuntimeConfig = shouldPrepareRuntimeConfig && options?.materializeManagedInstructions
      ? await runContextSvc.materializeManagedInstructionsForRun({
        id: agent.id,
        orgId: agent.orgId,
        name: agent.name,
        role: agent.role,
        workspaceKey: agent.workspaceKey,
        status: agent.status,
        agentRuntimeType: agentAdapterType,
        agentRuntimeConfig: agentAdapterConfig,
        metadata: agent.metadata ?? null,
      })
      : agentAdapterConfig;
    const preparedRuntime = shouldPrepareRuntimeConfig
      ? await runContextSvc.prepareRuntimeConfig({
        scene: "chat",
        materializeMissingRuntimeSkills: options?.materializeMissingRuntimeSkills !== false,
        agent: {
          id: agent.id,
          orgId: agent.orgId,
          name: agent.name,
          role: agent.role,
          workspaceKey: agent.workspaceKey,
          status: agent.status,
          agentRuntimeType: agentAdapterType,
          agentRuntimeConfig: preparedAgentRuntimeConfig,
          metadata: agent.metadata ?? null,
        },
      })
      : null;
    const runtimeConfig = preparedRuntime?.runtimeConfig ?? preparedAgentRuntimeConfig;
    const runtimeSkillEntries = preparedRuntime?.runtimeSkillEntries ?? [];
    return {
      descriptor: {
        sourceType: "agent",
        sourceLabel: agent.name,
        runtimeAgentId: agent.id,
        agentRuntimeType: agentAdapterType,
        model: modelLabel(runtimeConfig) ?? "Default model",
        effort: chatEffortFromConfig(agentAdapterType, runtimeConfig),
        available: true,
        error: null,
      },
      runtimeAgent: {
        id: agent.id,
        orgId: agent.orgId,
        name: agent.name,
        agentRuntimeType: agentAdapterType,
        agentRuntimeConfig: runtimeConfig,
      },
      agentRuntimeType: agentAdapterType,
      agentRuntimeConfig: runtimeConfig,
      runtimeSkills: summarizeRuntimeSkills(runtimeSkillEntries),
    };
  }

  async function resolveConversationRuntime(
    conversation: Pick<ChatConversation, "orgId" | "preferredAgentId" | "modelOverride" | "effortOverride">,
    options?: {
      prepareRuntimeConfig?: boolean;
      materializeManagedInstructions?: boolean;
      materializeMissingRuntimeSkills?: boolean;
      agentIdSnapshot?: string | null;
      modelSnapshot?: string | null;
      effortSnapshot?: string | null;
    },
  ) {
    const preferredAgentId = options && Object.prototype.hasOwnProperty.call(options, "agentIdSnapshot")
      ? safeTrim(options.agentIdSnapshot)
      : conversation.preferredAgentId;
    if (preferredAgentId) {
      const agentRuntime = await resolveAgentRuntime(
        conversation.orgId,
        preferredAgentId,
        options,
      );
      if (
        agentRuntime?.agentRuntimeType
        && agentRuntime.agentRuntimeConfig
        && agentRuntime.runtimeAgent
      ) {
        const model = options && Object.prototype.hasOwnProperty.call(options, "modelSnapshot")
          ? safeTrim(options.modelSnapshot)
          : safeTrim(conversation.modelOverride);
        const effort = options && Object.prototype.hasOwnProperty.call(options, "effortSnapshot")
          ? safeTrim(options.effortSnapshot)
          : conversation.effortOverride == null
            ? undefined
            : safeTrim(conversation.effortOverride);
        if (!model && effort === undefined) return agentRuntime;
        const shouldValidateRuntimeEffort = effort !== undefined
          || chatEffortFromConfig(agentRuntime.agentRuntimeType, agentRuntime.agentRuntimeConfig) !== null;
        let runtimeModelCatalog: Awaited<ReturnType<typeof discoverAgentRuntimeModels>>;
        if (
          shouldValidateRuntimeEffort
          && ["codex_local", "opencode_local", "pi_local", "cursor"].includes(agentRuntime.agentRuntimeType)
        ) {
          try {
            runtimeModelCatalog = await discoverAgentRuntimeModels(agentRuntime.agentRuntimeType);
          } catch {
            // Model discovery is advisory. Preserve the configured runtime when
            // a local CLI probe is unavailable; the adapter will still validate
            // against its built-in contract where one exists.
            runtimeModelCatalog = undefined;
          }
        }
        const derivedConfig = applyChatRuntimeOverrides(
          agentRuntime.agentRuntimeType,
          agentRuntime.agentRuntimeConfig,
          model,
          effort,
          runtimeModelCatalog,
        );
        return {
          ...agentRuntime,
          descriptor: {
            ...agentRuntime.descriptor,
            model: model ?? agentRuntime.descriptor.model,
            effort: chatEffortFromConfig(agentRuntime.agentRuntimeType, derivedConfig),
          },
          runtimeAgent: {
            ...agentRuntime.runtimeAgent,
            agentRuntimeConfig: derivedConfig,
          },
          agentRuntimeConfig: derivedConfig,
        };
      }
      if (agentRuntime) return agentRuntime;
    }

    return {
      descriptor: unconfiguredDescriptor("Choose a chat agent before sending messages."),
      runtimeAgent: null,
      agentRuntimeType: null,
      agentRuntimeConfig: null,
      runtimeSkills: [],
    } satisfies ResolvedChatRuntimeSource;
  }

  async function enrichConversation<T extends ChatConversation>(conversation: T): Promise<T> {
    const resolved = await resolveConversationRuntime(conversation, {
      materializeMissingRuntimeSkills: false,
    });
    let shortRef = conversation.shortRef;
    if (!shortRef) {
      try {
        shortRef = shortRefFor("chat", conversation.id);
      } catch {
        shortRef = undefined;
      }
    }
    return {
      ...conversation,
      ...(shortRef ? { shortRef } : {}),
      chatRuntime: resolved.descriptor,
    };
  }

  async function enrichConversations<T extends ChatConversation>(conversations: T[]): Promise<T[]> {
    return enrichConversationRuntimeDescriptors(
      conversations,
      async (conversation) => (await resolveConversationRuntime(conversation, {
        materializeMissingRuntimeSkills: false,
      })).descriptor,
    );
  }

  return {
    enrichConversation,
    enrichConversations,
    resolveChatInvocation,
    resolveConversationRuntime,
  };
}
