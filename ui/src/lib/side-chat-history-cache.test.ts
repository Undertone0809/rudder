import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { queryKeys } from "./queryKeys";
import { cacheKeptSideChat, invalidateSideChatHistory } from "./side-chat-history-cache";

const organizationId = "org-history";
const parentConversationId = "parent-history";

describe("Side Chat history cache lifecycle", () => {
  const clients: QueryClient[] = [];

  afterEach(() => {
    clients.splice(0).forEach((client) => client.clear());
  });

  function createQueryClient() {
    const client = new QueryClient();
    clients.push(client);
    return client;
  }

  it("invalidates only the requested parent's history for the active principal", async () => {
    const client = createQueryClient();
    const activePrincipalKey = queryKeys.chats.sideChats(
      organizationId,
      parentConversationId,
      "user-1",
    );
    const otherPrincipalKey = queryKeys.chats.sideChats(
      organizationId,
      parentConversationId,
      "user-2",
    );
    const otherParentKey = queryKeys.chats.sideChats(organizationId, "other-parent", "user-1");
    client.setQueryData(activePrincipalKey, { pages: [], pageParams: [] });
    client.setQueryData(otherPrincipalKey, { pages: [], pageParams: [] });
    client.setQueryData(otherParentKey, { pages: [], pageParams: [] });

    await invalidateSideChatHistory(client, organizationId, parentConversationId, "user-1");

    expect(client.getQueryState(activePrincipalKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(otherPrincipalKey)?.isInvalidated).toBe(false);
    expect(client.getQueryState(otherParentKey)?.isInvalidated).toBe(false);
  });

  it("caches a kept Side Chat and refreshes its parent's history", async () => {
    const client = createQueryClient();
    const conversation = { id: "kept-side-chat", title: "Kept Side Chat" };
    const detailKey = queryKeys.chats.detail(organizationId, conversation.id);
    const historyKey = queryKeys.chats.sideChats(organizationId, parentConversationId, "user-1");
    client.setQueryData(historyKey, { pages: [], pageParams: [] });

    await cacheKeptSideChat(client, conversation, organizationId, parentConversationId, "user-1");

    expect(client.getQueryData(detailKey)).toEqual(conversation);
    expect(client.getQueryState(historyKey)?.isInvalidated).toBe(true);
  });
});
