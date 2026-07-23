import type { ChatConversation, ChatRuntimeDescriptor } from "@rudderhq/shared";

export async function enrichConversationRuntimeDescriptors<T extends ChatConversation>(
  conversations: readonly T[],
  resolveDescriptor: (
    conversation: Pick<ChatConversation, "orgId" | "preferredAgentId" | "modelOverride">,
  ) => Promise<ChatRuntimeDescriptor>,
): Promise<T[]> {
  const descriptorPromises = new Map<string, Promise<ChatRuntimeDescriptor>>();

  return Promise.all(conversations.map(async (conversation) => {
    const key = JSON.stringify([
      conversation.orgId,
      conversation.preferredAgentId,
      conversation.modelOverride,
    ]);
    let descriptorPromise = descriptorPromises.get(key);
    if (!descriptorPromise) {
      descriptorPromise = resolveDescriptor(conversation);
      descriptorPromises.set(key, descriptorPromise);
    }

    return {
      ...conversation,
      chatRuntime: await descriptorPromise,
    };
  }));
}
