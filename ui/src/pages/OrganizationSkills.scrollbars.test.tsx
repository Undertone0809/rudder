// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrganizationSkillListItem } from "@rudderhq/shared";
import { SkillList } from "./OrganizationSkills";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("../components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("../components/MarkdownEditor", () => ({
  MarkdownEditor: () => <textarea aria-label="Mock markdown editor" />,
}));

const skills: OrganizationSkillListItem[] = Array.from({ length: 16 }, (_, index) => ({
  id: `skill-${index + 1}`,
  orgId: "org-1",
  name: `skill-${index + 1}`,
  slug: `skill-${index + 1}`,
  key: `rudder/skill-${index + 1}`,
  description: "A bundled skill with enough list entries to require scrolling.",
  sourceType: "local_path",
  sourceLocator: `/workspace/.agents/skills/skill-${index + 1}`,
  sourceRef: null,
  trustLevel: "scripts_executables",
  compatibility: "compatible",
  sourceBadge: "rudder",
  sourceLabel: "Bundled by Rudder",
  sourcePath: `/workspace/.agents/skills/skill-${index + 1}/SKILL.md`,
  workspaceEditPath: null,
  fileInventory: [{ path: "SKILL.md", kind: "skill" }],
  attachedAgentCount: 7,
  editable: false,
  editableReason: "Bundled Rudder skills are read-only.",
  createdAt: new Date("2026-05-16T00:00:00.000Z"),
  updatedAt: new Date("2026-05-16T00:00:00.000Z"),
}));

let cleanupFn: (() => void) | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  Object.defineProperty(window, "sessionStorage", {
    configurable: true,
    value: {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
    },
  });
});

afterEach(() => {
  act(() => {
    cleanupFn?.();
  });
  cleanupFn = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

function renderSkillList() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root | null = null;
  act(() => {
    root = createRoot(container);
    root.render(
      <SkillList
        skills={skills}
        selectedSkillId="skill-1"
        skillFilter=""
        onSelectSkill={vi.fn()}
      />,
    );
  });
  cleanupFn = () => root?.unmount();
}

describe("OrganizationSkills list scroll region", () => {
  it("fills its parent and only marks the scrollbar active while scrolling", () => {
    renderSkillList();

    const listScroll = document.querySelector("[data-testid='organization-skills-list-scroll']");

    expect(listScroll?.classList.contains("scrollbar-auto-hide")).toBe(true);
    expect(listScroll?.classList.contains("h-full")).toBe(true);
    expect(listScroll?.classList.contains("overflow-y-auto")).toBe(true);
    expect(listScroll?.classList.contains("flex-1")).toBe(false);

    act(() => {
      listScroll?.dispatchEvent(new Event("scroll"));
    });
    expect(listScroll?.classList.contains("is-scrolling")).toBe(true);

    act(() => {
      vi.advanceTimersByTime(701);
    });
    expect(listScroll?.classList.contains("is-scrolling")).toBe(false);
  });
});
