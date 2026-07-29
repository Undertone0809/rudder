import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  onboardingCreationPhaseTitle,
  OnboardingCreationProgress,
  type OnboardingCreationPhase,
} from "./OnboardingWizard.progress";

describe("OnboardingCreationProgress", () => {
  it.each([
    ["creating_organization", "Creating organization", "reserving its workspace"],
    ["saving_organization", "Saving organization", "latest organization details"],
    ["checking_runtime", "Checking agent runtime", "Verifying the selected runtime"],
    ["creating_agent", "Creating agent", "Setting up your first agent"],
    [
      "preparing_starter_workspace",
      "Preparing starter workspace",
      "Adding Getting Started guidance",
    ],
  ] satisfies Array<[OnboardingCreationPhase, string, string]>)(
    "describes the %s phase",
    (phase, title, description) => {
      const html = renderToStaticMarkup(
        <OnboardingCreationProgress phase={phase} />,
      );

      expect(html).toContain(`aria-label="${title}..."`);
      expect(html).toContain(description);
      expect(onboardingCreationPhaseTitle(phase)).toBe(title);
    },
  );

  it("keeps a useful fallback label before an asynchronous phase begins", () => {
    expect(onboardingCreationPhaseTitle(null)).toBe("Creating");
  });
});
