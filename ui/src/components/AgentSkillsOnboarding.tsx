import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Search, Shapes } from "lucide-react";
import { useState } from "react";

export const AGENT_SKILLS_ONBOARDING_STORAGE_KEY = "rudder:agent-skills:onboarding:v1";
const EXTERNAL_SKILLS_ONBOARDING_COPY = "Rudder also discovers compatible skills already installed for local runtimes such as Codex and Claude Code. Search this page to find them under External skills, then enable the ones this agent should load.";

function hasDismissedAgentSkillsOnboarding() {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(AGENT_SKILLS_ONBOARDING_STORAGE_KEY) === "dismissed";
  } catch {
    return false;
  }
}

export function AgentSkillsOnboarding() {
  const [visible, setVisible] = useState(() => !hasDismissedAgentSkillsOnboarding());

  const dismiss = () => {
    try {
      window.localStorage.setItem(AGENT_SKILLS_ONBOARDING_STORAGE_KEY, "dismissed");
    } catch {
      // Keep dismissal useful for the current visit when storage is unavailable.
    }
    setVisible(false);
  };

  return (
    <Dialog
      open={visible}
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
    >
      <DialogContent
        className="gap-0 overflow-hidden p-0 sm:max-w-[30rem]"
        showCloseButton={false}
      >
        <div className="flex items-start gap-3 border-b border-border/70 px-5 pb-4 pt-5">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-foreground text-background">
            <Shapes className="h-4.5 w-4.5" aria-hidden />
          </div>
          <DialogHeader className="min-w-0 gap-1 text-left">
            <DialogTitle className="text-base leading-6">
              Build your agent&apos;s skill set
            </DialogTitle>
            <DialogDescription className="text-sm leading-5">
              Manage which skills this agent can load for its work.
            </DialogDescription>
          </DialogHeader>
        </div>
        <div className="px-5 py-4">
          <div className="flex items-start gap-3 rounded-[var(--radius-md)] bg-muted/55 px-3.5 py-3">
            <Search className="mt-0.5 h-4 w-4 shrink-0 text-foreground/70" aria-hidden />
            <p className="text-sm leading-5 text-muted-foreground">
              {EXTERNAL_SKILLS_ONBOARDING_COPY}
            </p>
          </div>
        </div>
        <DialogFooter className="border-t border-border/70 px-5 py-4">
          <Button type="button" onClick={dismiss}>
            Got it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
