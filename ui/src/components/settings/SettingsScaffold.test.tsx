// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Settings } from "lucide-react";
import { afterEach, describe, expect, it } from "vitest";
import {
  SettingsActions,
  SettingsChoiceGrid,
  SettingsField,
  SettingsGroup,
  SettingsItem,
  SettingsPage,
  SettingsPageHeader,
} from "./SettingsScaffold";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

function renderScaffold() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);

  act(() => {
    root!.render(
      <SettingsPage width="wide" aria-label="Settings example">
        <SettingsPageHeader
          eyebrow="Workspace"
          icon={Settings}
          title="General"
          description="Manage workspace defaults."
        />
        <SettingsGroup variant="feature">
          <SettingsItem
            headingLevel={2}
            icon={Settings}
            title="Agent access"
            description="Allow agents to use this capability."
            action={<button type="button">Configure</button>}
          />
          <SettingsField
            label="Display name"
            description="Shown throughout Rudder."
            htmlFor="display-name"
          >
            <input id="display-name" defaultValue="Operator" />
          </SettingsField>
          <SettingsField label="Generated prompt">
            <textarea readOnly defaultValue="Invite an agent" />
          </SettingsField>
          <SettingsActions>
            <button type="button">Cancel</button>
            <button type="button">Save</button>
          </SettingsActions>
        </SettingsGroup>
        <SettingsChoiceGrid columns={4}>
          <button type="button">Light</button>
          <button type="button">Dark</button>
        </SettingsChoiceGrid>
      </SettingsPage>,
    );
  });

  return container;
}

describe("SettingsScaffold", () => {
  it("composes a semantic settings page from stable slots and associated controls", () => {
    const page = renderScaffold();
    const settingsPage = page.querySelector('[data-slot="settings-page"]');
    const header = page.querySelector('[data-slot="settings-page-header"]');
    const group = page.querySelector('[data-slot="settings-group"]');
    const items = page.querySelectorAll('[data-slot="settings-item"]');
    const actions = page.querySelector('[data-slot="settings-actions"]');
    const choiceGrid = page.querySelector('[data-slot="settings-choice-grid"]');

    expect(settingsPage?.getAttribute("data-width")).toBe("wide");
    expect(settingsPage?.getAttribute("aria-label")).toBe("Settings example");
    expect(header?.querySelector("h1")?.textContent).toBe("General");
    expect(header?.textContent).toContain("Workspace");
    expect(header?.textContent).toContain("Manage workspace defaults.");
    expect(group?.getAttribute("data-variant")).toBe("feature");
    expect(items).toHaveLength(3);
    expect(items[0]?.querySelector("h2")?.textContent).toBe("Agent access");
    expect(items[0]?.querySelector("button")?.textContent).toBe("Configure");

    const label = items[1]?.querySelector("label");
    expect(label?.getAttribute("for")).toBe("display-name");
    expect(label?.textContent).toBe("Display name");
    expect(items[1]?.textContent).toContain("Shown throughout Rudder.");
    expect(items[1]?.querySelector("input")?.getAttribute("id")).toBe("display-name");
    expect(items[2]?.querySelector("label")).toBeNull();
    expect(items[2]?.textContent).toContain("Generated prompt");

    expect(actions?.querySelectorAll("button")).toHaveLength(2);
    expect(choiceGrid?.querySelectorAll("button")).toHaveLength(2);
    expect(choiceGrid?.className).toContain("lg:grid-cols-4");
  });
});
