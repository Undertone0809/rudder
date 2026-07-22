import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Download, FileAudio2, FileVideo2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

export function WorkspaceMediaPreview({
  kind,
  src,
  contentType,
  title,
  openAction,
  className,
  testId = "workspace-media-preview",
}: {
  kind: "video" | "audio";
  src: string;
  contentType: string | null;
  title: string;
  openAction?: ReactNode;
  className?: string;
  testId?: string;
}) {
  const identity = `${kind}:${src}`;
  const [failedIdentity, setFailedIdentity] = useState<string | null>(null);
  const failed = failedIdentity === identity;
  const label = `${title || `Library ${kind}`} ${kind} preview`;
  const MediaIcon = kind === "video" ? FileVideo2 : FileAudio2;
  const actions = (
    <div className="flex flex-wrap items-center justify-center gap-2">
      <Button asChild variant="outline" size="sm" className="h-8 gap-1.5">
        <a href={src} download>
          <Download className="h-3.5 w-3.5" aria-hidden="true" />
          Download
        </a>
      </Button>
      {openAction}
    </div>
  );

  useEffect(() => {
    setFailedIdentity(null);
  }, [identity]);

  if (failed) {
    return (
      <div
        className={cn("flex min-h-[320px] flex-1 items-center justify-center px-6 py-10", className)}
        data-testid={`${testId}-fallback`}
        role="alert"
      >
        <div className="flex max-w-md flex-col items-center text-center">
          <MediaIcon className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
          <p className="mt-3 text-sm font-medium text-foreground">
            This {kind} can’t be played in this browser.
          </p>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            The file may use a codec your browser does not support. Download it or open it with another app.
          </p>
          <div className="mt-4">{actions}</div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn("flex min-h-[320px] min-w-0 flex-1 flex-col bg-accent/10", className)}
      data-testid={`${testId}-frame`}
      data-workspace-media-preview={kind}
    >
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
        {kind === "video" ? (
          <video
            key={identity}
            aria-label={label}
            className="h-auto w-full max-h-full max-w-5xl rounded-md bg-black shadow-sm"
            controls
            playsInline
            preload="metadata"
            src={src}
            data-content-type={contentType ?? undefined}
            data-testid={testId}
            onError={() => setFailedIdentity(identity)}
            onLoadedMetadata={() => setFailedIdentity(null)}
          />
        ) : (
          <audio
            key={identity}
            aria-label={label}
            className="w-full max-w-2xl"
            controls
            preload="metadata"
            src={src}
            data-content-type={contentType ?? undefined}
            data-testid={testId}
            onError={() => setFailedIdentity(identity)}
            onLoadedMetadata={() => setFailedIdentity(null)}
          />
        )}
      </div>
      <div className="shrink-0 border-t border-[color:var(--border-soft)] bg-[color:var(--surface-page)] px-3 py-2">
        {actions}
      </div>
    </div>
  );
}
