// @vitest-environment jsdom

import type { Project } from "@rudderhq/shared";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectProperties } from "./ProjectProperties";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("./agent-config-primitives", () => ({
  DraftInput: ({ value }: { value: string }) => <input value={value} readOnly />,
}));

vi.mock("./InlineEditor", () => ({
  InlineEditor: ({ value }: { value: string }) => <span>{value}</span>,
}));

const project: Project = {
  id: "project-1",
  orgId: "org-1",
  urlKey: "project-1",
  goalId: "goal-1",
  goalIds: ["goal-1"],
  goals: [{ id: "goal-1", title: "Hidden experimental Goal" }],
  name: "Goal-linked project",
  description: null,
  status: "in_progress",
  leadAgentId: null,
  targetDate: null,
  color: "#22c55e",
  icon: "folder",
  pauseReason: null,
  pausedAt: null,
  executionWorkspacePolicy: null,
  codebase: {
    configured: false,
    scope: "none",
    workspaceId: null,
    repoUrl: null,
    repoRef: null,
    defaultRef: null,
    repoName: null,
    localFolder: null,
    managedFolder: "",
    effectiveLocalFolder: "",
    origin: "local_folder",
  },
  resources: [],
  workspaces: [],
  primaryWorkspace: null,
  archivedAt: null,
  createdAt: new Date("2026-08-06T00:00:00.000Z"),
  updatedAt: new Date("2026-08-06T00:00:00.000Z"),
};

let cleanup: (() => void) | null = null;

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  cleanup?.();
  cleanup = null;
  document.body.innerHTML = "";
});

function renderProperties() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<ProjectProperties project={project} onUpdate={vi.fn()} />));
  cleanup = () => {
    act(() => root.unmount());
    container.remove();
  };
  return container;
}

describe("ProjectProperties", () => {
  it("does not expose Goal relationships in project configuration", () => {
    const container = renderProperties();
    expect(container.textContent).not.toContain("Hidden experimental Goal");
    expect(container.querySelector('a[href="/goals/goal-1"]')).toBeNull();
    expect(container.textContent).not.toContain("Goals");
  });
});
