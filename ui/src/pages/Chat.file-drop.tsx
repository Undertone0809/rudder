import { Paperclip } from "lucide-react";
import { useCallback, useRef, useState, type DragEvent as ReactDragEvent } from "react";

function isFileDrag(event: ReactDragEvent<HTMLElement>) {
  const transfer = event.dataTransfer;
  return transfer.files.length > 0
    || Array.from(transfer.types ?? []).includes("Files")
    || Array.from(transfer.items ?? []).some((item) => item.kind === "file");
}

export function useChatComposerFileDrop(
  onFiles: (files: Iterable<File>) => void | Promise<void>,
) {
  const [active, setActive] = useState(false);
  const depthRef = useRef(0);
  const onDragEnter = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    depthRef.current += 1;
    setActive(true);
  }, []);
  const onDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
  }, []);
  const onDragLeave = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (depthRef.current === 0 && !isFileDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    depthRef.current = Math.max(0, depthRef.current - 1);
    if (depthRef.current === 0) setActive(false);
  }, []);
  const onDrop = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (depthRef.current === 0 && !isFileDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    depthRef.current = 0;
    setActive(false);
    void onFiles(event.dataTransfer.files);
  }, [onFiles]);

  return {
    active,
    targetProps: {
      onDragEnter,
      onDragOver,
      onDragLeave,
      onDrop,
    },
  };
}

export function ChatComposerFileDropOverlay() {
  return (
    <div
      data-testid="chat-composer-file-drop-overlay"
      role="status"
      aria-live="polite"
      className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-[inherit] border border-[color:color-mix(in_oklab,var(--accent-base)_55%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-elevated)_88%,transparent)] backdrop-blur-[2px]"
    >
      <div className="flex items-center gap-2 rounded-[var(--radius-md)] bg-[color:var(--accent-soft)] px-3 py-2 text-sm font-medium text-foreground shadow-[var(--shadow-sm)]">
        <Paperclip className="h-4 w-4 text-[color:var(--accent-base)]" aria-hidden />
        Drop files to attach
      </div>
    </div>
  );
}
