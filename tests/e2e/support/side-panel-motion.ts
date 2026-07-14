import { expect, type Page } from "@playwright/test";

export type SidePanelMotionSample = {
  composerWidth: number | null;
  mainWidth: number;
  messageWidth: number | null;
  panelContentPresent: boolean;
  panelLeft: number;
  panelRight: number;
  panelWidth: number;
  workspaceRight: number;
};

export async function sampleSidePanelMotion(
  page: Page,
  action: () => Promise<unknown>,
): Promise<SidePanelMotionSample[]> {
  await page.evaluate(() => {
    const samples: SidePanelMotionSample[] = [];
    const state = window as typeof window & { __rudderSidePanelMotionSamples?: SidePanelMotionSample[] };
    state.__rudderSidePanelMotionSamples = samples;
    const startedAt = performance.now();

    const capture = () => {
      const workspace = document.querySelector<HTMLElement>("[data-testid='workspace-main-panel-stack']");
      const panel = document.querySelector<HTMLElement>(
        "[data-testid='side-panel-stable-host'], [data-testid='side-panel-expanded-overlay']",
      );
      const main = document.querySelector<HTMLElement>("[data-testid='workspace-main-card']");
      const messages = document.querySelector<HTMLElement>("[data-testid='chat-messages-content']");
      const composer = document.querySelector<HTMLElement>("[data-testid='chat-composer-content']");
      if (workspace && panel && main) {
        const workspaceRect = workspace.getBoundingClientRect();
        const panelRect = panel.getBoundingClientRect();
        const mainRect = main.getBoundingClientRect();
        const messageRect = messages?.getBoundingClientRect() ?? null;
        const composerRect = composer?.getBoundingClientRect() ?? null;
        samples.push({
          composerWidth: composerRect?.width ?? null,
          mainWidth: mainRect.width,
          messageWidth: messageRect?.width ?? null,
          panelContentPresent: document.querySelector("[data-testid='chat-side-panel']") !== null,
          panelLeft: panelRect.left,
          panelRight: panelRect.right,
          panelWidth: panelRect.width,
          workspaceRight: workspaceRect.right,
        });
      }
      if (performance.now() - startedAt < 420) requestAnimationFrame(capture);
    };

    capture();
  });

  await action();
  await page.waitForTimeout(460);
  return page.evaluate(() => (
    (window as typeof window & { __rudderSidePanelMotionSamples?: SidePanelMotionSample[] })
      .__rudderSidePanelMotionSamples ?? []
  ));
}

function expectMonotonic(values: number[], direction: "increasing" | "decreasing") {
  expect(values.length).toBeGreaterThan(2);
  let extreme = values[0]!;
  for (let index = 1; index < values.length; index += 1) {
    const current = values[index]!;
    if (direction === "increasing") {
      expect(current).toBeGreaterThanOrEqual(extreme - 2);
      extreme = Math.max(extreme, current);
    } else {
      expect(current).toBeLessThanOrEqual(extreme + 2);
      extreme = Math.min(extreme, current);
    }
  }
}

function expectMeaningfulChange(
  values: number[],
  direction: "increasing" | "decreasing",
  minimumDelta: number,
) {
  expect(values.length).toBeGreaterThan(2);
  const first = values[0]!;
  const last = values.at(-1)!;
  const delta = direction === "increasing" ? last - first : first - last;
  expect(delta).toBeGreaterThanOrEqual(minimumDelta);
  const lower = Math.min(first, last) + 2;
  const upper = Math.max(first, last) - 2;
  expect(values.some((value) => value > lower && value < upper)).toBe(true);
}

export function expectRightAnchoredSidePanelMotion(
  samples: SidePanelMotionSample[],
  direction: "opening" | "closing",
  options: {
    checkClosingContent?: boolean;
    checkMessageWidth?: boolean;
    endPanelWidth?: { max?: number; min?: number };
  } = {},
) {
  expect(samples.length).toBeGreaterThan(2);
  for (const sample of samples) {
    expect(Math.abs(sample.panelRight - sample.workspaceRight)).toBeLessThanOrEqual(2);
  }

  expectMonotonic(
    samples.map((sample) => sample.panelWidth),
    direction === "opening" ? "increasing" : "decreasing",
  );
  expectMeaningfulChange(
    samples.map((sample) => sample.panelWidth),
    direction === "opening" ? "increasing" : "decreasing",
    24,
  );
  const finalPanelWidth = samples.at(-1)!.panelWidth;
  if (options.endPanelWidth?.min !== undefined) {
    expect(finalPanelWidth).toBeGreaterThanOrEqual(options.endPanelWidth.min);
  }
  if (options.endPanelWidth?.max !== undefined) {
    expect(finalPanelWidth).toBeLessThanOrEqual(options.endPanelWidth.max);
  }
  if (options.checkClosingContent) {
    for (const sample of samples.filter((candidate) => candidate.panelWidth > 2)) {
      expect(sample.panelContentPresent).toBe(true);
    }
  }
  expectMonotonic(
    samples.map((sample) => sample.mainWidth),
    direction === "opening" ? "decreasing" : "increasing",
  );
  expectMeaningfulChange(
    samples.map((sample) => sample.mainWidth),
    direction === "opening" ? "decreasing" : "increasing",
    24,
  );

  if (options.checkMessageWidth) {
    const messageWidths = samples.flatMap((sample) => sample.messageWidth === null ? [] : [sample.messageWidth]);
    const messageDirection = direction === "opening" ? "decreasing" : "increasing";
    expectMonotonic(messageWidths, messageDirection);
    expectMeaningfulChange(messageWidths, messageDirection, 8);

    const composerWidths = samples.flatMap((sample) => sample.composerWidth === null ? [] : [sample.composerWidth]);
    expectMonotonic(composerWidths, messageDirection);
    expectMeaningfulChange(composerWidths, messageDirection, 8);
  }
}
