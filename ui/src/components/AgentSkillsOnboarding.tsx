import { Button } from "@/components/ui/button";
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

  if (!visible) return null;

  const dismiss = () => {
    try {
      window.localStorage.setItem(AGENT_SKILLS_ONBOARDING_STORAGE_KEY, "dismissed");
    } catch {
      // Keep dismissal useful for the current visit when storage is unavailable.
    }
    setVisible(false);
  };

  return (
    <section
      aria-labelledby="agent-skills-onboarding-title"
      className="motion-content-reveal rounded-xl border border-border bg-[color:var(--surface-elevated)] px-4 py-4"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-3.5">
        <div className="flex min-w-0 flex-1 items-start gap-3.5">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-foreground text-background">
            <Shapes className="h-4.5 w-4.5" aria-hidden />
          </div>
          <div className="min-w-0 flex-1">
            <h3
              id="agent-skills-onboarding-title"
              className="text-sm font-semibold text-foreground"
            >
              Build your agent&apos;s skill set
            </h3>
            <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
              Manage which skills this agent can load for its work.
            </p>
            <div className="mt-3 flex max-w-4xl items-start gap-2.5 rounded-lg bg-muted/45 px-3 py-2.5">
              <Search className="mt-0.5 h-3.5 w-3.5 shrink-0 text-foreground/70" aria-hidden />
              <p className="text-xs leading-5 text-muted-foreground">
                {EXTERNAL_SKILLS_ONBOARDING_COPY}
              </p>
            </div>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="ml-[3.125rem] shrink-0 self-start sm:ml-0"
          onClick={dismiss}
        >
          Got it
        </Button>
      </div>
    </section>
  );
}
