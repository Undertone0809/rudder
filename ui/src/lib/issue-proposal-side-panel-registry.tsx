import { useSyncExternalStore, type ReactNode } from "react";

type IssueProposalPanelSnapshot = {
  content: ReactNode;
  version: number;
};

const EMPTY_SNAPSHOT: IssueProposalPanelSnapshot = {
  content: null,
  version: 0,
};

const snapshots = new Map<string, IssueProposalPanelSnapshot>();
const listeners = new Map<string, Set<() => void>>();

function emit(key: string) {
  for (const listener of listeners.get(key) ?? []) listener();
}

export function publishIssueProposalPanelContent(key: string, content: ReactNode) {
  const previous = snapshots.get(key);
  snapshots.set(key, {
    content,
    version: (previous?.version ?? 0) + 1,
  });
  emit(key);
}

export function clearIssueProposalPanelContent(key: string) {
  if (!snapshots.delete(key)) return;
  emit(key);
}

function subscribe(key: string, listener: () => void) {
  const keyListeners = listeners.get(key) ?? new Set<() => void>();
  keyListeners.add(listener);
  listeners.set(key, keyListeners);
  return () => {
    keyListeners.delete(listener);
    if (keyListeners.size === 0) listeners.delete(key);
  };
}

function getSnapshot(key: string) {
  return snapshots.get(key) ?? EMPTY_SNAPSHOT;
}

export function IssueProposalSidePanelContent({ targetKey }: { targetKey: string }) {
  const snapshot = useSyncExternalStore(
    (listener) => subscribe(targetKey, listener),
    () => getSnapshot(targetKey),
    () => EMPTY_SNAPSHOT,
  );
  return (
    <div
      className="h-full min-h-0"
      data-testid="chat-side-panel-issue-proposal-content"
    >
      <span className="sr-only" role="status">Issue proposal opened in Side Panel.</span>
      {snapshot.content}
    </div>
  );
}
