import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readChatDraft, saveChatDraft } from "./chat-draft-storage";
import { FirstChatTurnStore } from "./chat-first-turn-store";
import { readChatPendingAttachmentsForScope, resetChatPendingAttachmentsForTests, updateChatPendingAttachmentsForScope } from "./chat-pending-attachments";

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
  resetChatPendingAttachmentsForTests();
});
afterEach(() => vi.unstubAllGlobals());

const turn = { streamKey: "one", body: "keep my draft", files: [] as File[], createdAt: new Date() };

describe("first chat operation lifetime", () => {
  it("does not restore over a newer submitted turn whose source was cleared", () => {
    const store = new FirstChatTurnStore();
    store.setOwner("org-a:route-1");
    store.begin("org-a:route-1", turn, "org-a:__new__");
    store.setOwner("org-a:route-2");
    store.begin("org-a:route-2", { ...turn, streamKey: "newer" }, "org-a:__new__");
    expect(store.recoverDraft("org-a:route-1", "one", "org-a", null)?.conversationId).toBe("first-turn-recovery:one");
    expect(readChatDraft("org-a", null)).toBe("");
    expect(store.getSnapshot().pending?.streamKey).toBe("newer");
  });
  it.each(["org-a:route-2", "org-b:route-1"])("recovers an inactive operation without touching %s", (destination) => {
    const store = new FirstChatTurnStore();
    const file = new File(["original"], "original.txt");
    store.setOwner("org-a:route-1");
    store.begin("org-a:route-1", { ...turn, files: [file] });
    store.setOwner(destination);
    store.begin(destination, { ...turn, streamKey: "newer" });
    const snapshot = store.getSnapshot();
    const recovery = store.recoverDraft("org-a:route-1", "one", "org-a", null);
    expect(recovery?.conversationId).toBeNull();
    expect(readChatDraft("org-a", null)).toBe(turn.body);
    expect(readChatPendingAttachmentsForScope("org-a:__new__")).toEqual([file]);
    expect(store.getSnapshot()).toBe(snapshot);
    expect(store.recoverDraft("org-a:route-1", "one", "org-a", null)).toBeNull();
  });
  it.each(["text", "attachment"])("keeps original recovery separately when a newer source %s exists", (kind) => {
    const store = new FirstChatTurnStore();
    const original = new File(["old"], "old.txt");
    const newer = new File(["new"], "new.txt");
    store.setOwner("org-a:route-1");
    store.begin("org-a:route-1", { ...turn, files: [original] });
    store.setOwner("org-a:route-2");
    if (kind === "text") saveChatDraft("org-a", null, "new draft");
    else updateChatPendingAttachmentsForScope("org-a:__new__", () => [newer]);
    const recovered = store.recoverDraft("org-a:route-1", "one", "org-a", null)!;
    expect(recovered.conversationId).toBe("first-turn-recovery:one");
    expect(readChatDraft("org-a", recovered.conversationId)).toBe(turn.body);
    expect(readChatPendingAttachmentsForScope(`org-a:${recovered.conversationId}`)).toEqual([original]);
    expect(readChatDraft("org-a", null)).toBe(kind === "text" ? "new draft" : "");
    expect(readChatPendingAttachmentsForScope("org-a:__new__")).toEqual(kind === "attachment" ? [newer] : []);
    expect(store.readRecoveredTurn("org-a", recovered.conversationId)?.files[0]).toBe(original);
    const recoveryScope = `org-a:${recovered.conversationId}`;
    store.begin("org-a:route-2", { ...turn, streamKey: "retry" }, recoveryScope);
    store.finish("org-a:route-2", "retry");
    expect(store.readRecoveredTurn("org-a", recovered.conversationId)).toBeUndefined();
  });
  it("retains content and the synchronous send claim across page subscriptions", () => {
    const store = new FirstChatTurnStore();
    store.setOwner("org-a:route-1");
    const detach = store.subscribe(() => {});
    expect(store.begin("org-a:route-1", turn)).toBe(true);
    detach();
    const remounted = store.subscribe(() => {});
    expect(store.getSnapshot().pending).toEqual(turn);
    expect(store.begin("org-a:route-1", { ...turn, streamKey: "duplicate" })).toBe(false);
    expect(store.owns("org-a:route-1", "one")).toBe(true);
    remounted();
  });
  it.each(["org-a:route-2", "org-b:route-1"])("revokes ownership at boundary %s", (destination) => {
    const store = new FirstChatTurnStore();
    store.setOwner("org-a:route-1");
    store.begin("org-a:route-1", turn);
    store.setOwner(destination);
    expect(store.getSnapshot().pending).toBeNull();
    expect(store.owns("org-a:route-1", "one")).toBe(false);
    store.begin(destination, { ...turn, streamKey: "newer" });
    expect(store.finish("org-a:route-1", "one", true)).toBe(false);
    expect(store.getSnapshot().pending?.streamKey).toBe("newer");
    expect(store.getSnapshot().recovery).toBe(0);
  });
  it("publishes original recovery state after failure and permits one retry", () => {
    const store = new FirstChatTurnStore();
    store.setOwner("org-a:route-1");
    store.begin("org-a:route-1", turn);
    expect(store.finish("org-a:route-1", "one", true)).toBe(true);
    expect(store.getSnapshot().recoveredTurn).toEqual(turn);
    expect(store.begin("org-a:route-1", { ...turn, streamKey: "retry" })).toBe(true);
    expect(store.finish("org-a:route-1", "one")).toBe(false);
    expect(store.getSnapshot().pending?.streamKey).toBe("retry");
  });
});
