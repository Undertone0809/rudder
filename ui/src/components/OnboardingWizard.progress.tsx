import { Loader2 } from "lucide-react";
import { TextDots } from "./TextDots";

export type OnboardingCreationPhase =
  | "creating_organization"
  | "saving_organization"
  | "checking_runtime"
  | "creating_agent"
  | "preparing_starter_workspace";

const CREATION_PHASES: Record<
  OnboardingCreationPhase,
  { title: string; description: string }
> = {
  creating_organization: {
    title: "Creating organization",
    description: "Saving your organization and reserving its workspace.",
  },
  saving_organization: {
    title: "Saving organization",
    description: "Applying your latest organization details.",
  },
  checking_runtime: {
    title: "Checking agent runtime",
    description: "Verifying the selected runtime before setup continues.",
  },
  creating_agent: {
    title: "Creating agent",
    description: "Setting up your first agent and its working defaults.",
  },
  preparing_starter_workspace: {
    title: "Preparing starter workspace",
    description: "Adding Getting Started guidance for your first work loop.",
  },
};

export function onboardingCreationPhaseTitle(
  phase: OnboardingCreationPhase | null,
) {
  return phase ? CREATION_PHASES[phase].title : "Creating";
}

export function OnboardingCreationProgress({
  phase,
}: {
  phase: OnboardingCreationPhase;
}) {
  const content = CREATION_PHASES[phase];

  return (
    <div
      key={phase}
      data-testid="onboarding-creation-progress"
      className="mt-4 flex items-start gap-3 rounded-[var(--radius-md)] border border-[color:var(--border-strong)] bg-[color:var(--surface-elevated)] px-3.5 py-3 shadow-[var(--shadow-sm)] animate-in fade-in slide-in-from-bottom-1 duration-300 motion-reduce:animate-none"
    >
      <Loader2
        aria-hidden="true"
        className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-foreground motion-reduce:animate-none"
      />
      <div className="min-w-0">
        <TextDots text={content.title} className="text-xs font-medium text-foreground" />
        <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
          {content.description}
        </p>
      </div>
    </div>
  );
}
