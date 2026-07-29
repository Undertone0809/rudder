import { Button } from "@/components/ui/button";
import { Shapes } from "lucide-react";
import { useState } from "react";
import { OnboardingCallout } from "./OnboardingCallout";

export const AGENT_SKILLS_ONBOARDING_STORAGE_KEY = "rudder:agent-skills:onboarding:v1";
const EXTERNAL_SKILLS_ONBOARDING_COPY = "Rudder also finds compatible skills already installed for local runtimes such as Codex and Claude Code. Search under External skills, then enable what this agent should load.";

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

  if (!visible) return null;

  return (
    <OnboardingCallout
      icon={<Shapes aria-hidden />}
      title="Build your agent's skill set"
      description={EXTERNAL_SKILLS_ONBOARDING_COPY}
      testId="agent-skills-onboarding"
      actions={(
        <Button type="button" size="sm" onClick={dismiss}>
          Got it
        </Button>
      )}
    />
  );
}
