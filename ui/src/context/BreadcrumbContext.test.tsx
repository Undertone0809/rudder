// @vitest-environment jsdom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { BreadcrumbProvider, useBreadcrumbs, type Breadcrumb } from "./BreadcrumbContext";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function BreadcrumbPublisher({ crumbs }: { crumbs: Breadcrumb[] }) {
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs(crumbs);
  }, [crumbs, setBreadcrumbs]);

  return null;
}

function BreadcrumbProbe({ testId }: { testId: string }) {
  const { breadcrumbs } = useBreadcrumbs();
  return (
    <div data-testid={testId}>
      {breadcrumbs.map((breadcrumb) => breadcrumb.label).join(" > ")}
    </div>
  );
}

describe("BreadcrumbProvider", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    root = null;
    container?.remove();
    container = null;
    document.title = "";
  });

  it("keeps overlay breadcrumbs isolated from the outer shell", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    const issueCrumbs = [
      { label: "Issues" },
      { label: "ZST-394 Multi-reviewer design" },
    ];
    const settingsCrumbs = [
      { label: "System settings" },
      { label: "Shortcuts" },
    ];

    await act(async () => {
      root!.render(
        <BreadcrumbProvider>
          <BreadcrumbPublisher crumbs={issueCrumbs} />
          <BreadcrumbProbe testId="outer-breadcrumbs" />
          <BreadcrumbProvider manageDocumentTitle={false}>
            <BreadcrumbPublisher crumbs={settingsCrumbs} />
            <BreadcrumbProbe testId="overlay-breadcrumbs" />
          </BreadcrumbProvider>
        </BreadcrumbProvider>,
      );
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="outer-breadcrumbs"]')?.textContent)
      .toBe("Issues > ZST-394 Multi-reviewer design");
    expect(container.querySelector('[data-testid="overlay-breadcrumbs"]')?.textContent)
      .toBe("System settings > Shortcuts");
    expect(document.title).toBe("ZST-394 Multi-reviewer design · Issues · Rudder");
  });
});
