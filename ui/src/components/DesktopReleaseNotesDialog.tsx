import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { readDesktopShell, type DesktopReleaseNotes } from "@/lib/desktop-shell";
import { useEffect, useRef, useState } from "react";
import { RudderLogo } from "./RudderLogo";

export function DesktopReleaseNotesDialog() {
  const [notes, setNotes] = useState<DesktopReleaseNotes | null>(null);
  const notesRef = useRef<DesktopReleaseNotes | null>(null);

  useEffect(() => {
    const desktopShell = readDesktopShell();
    if (!desktopShell?.getReleaseNotes) return;

    let cancelled = false;
    void desktopShell.getReleaseNotes()
      .then((result) => {
        if (cancelled || result.status !== "available") return;
        notesRef.current = result.notes;
        setNotes(result.notes);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, []);

  async function close() {
    const current = notesRef.current;
    notesRef.current = null;
    setNotes(null);
    if (!current) return;
    await readDesktopShell()?.markReleaseNotesShown?.(current.version).catch(() => undefined);
  }

  return (
    <Dialog
      open={notes !== null}
      onOpenChange={(open) => {
        if (!open) void close();
      }}
    >
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-[36rem]" showCloseButton={false}>
        <div className="flex items-start gap-3 border-b border-border/70 px-5 pb-4 pt-5">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-md)] border border-border bg-background shadow-sm">
            <RudderLogo alt="Rudder" className="h-6 w-6 ring-0" />
          </span>
          <DialogHeader className="min-w-0 gap-1 text-left">
            <DialogTitle className="text-base leading-6">
              {notes?.title ?? "What's new in Rudder"}
            </DialogTitle>
            <DialogDescription className="text-sm leading-5">
              Updates installed with this version.
            </DialogDescription>
          </DialogHeader>
        </div>
        <div className="max-h-[min(62vh,34rem)] overflow-y-auto px-5 py-4">
          <div className="space-y-4">
            {notes?.sections.map((section) => (
              <section key={section.title} className="space-y-2">
                <h2 className="text-sm font-semibold text-foreground">{section.title}</h2>
                <ul className="space-y-1.5 text-sm leading-5 text-muted-foreground">
                  {section.items.map((item) => (
                    <li key={item} className="flex gap-2">
                      <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-muted-foreground/70" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </div>
        <DialogFooter className="border-t border-border/70 px-5 py-4">
          <Button type="button" onClick={() => void close()}>
            Continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
