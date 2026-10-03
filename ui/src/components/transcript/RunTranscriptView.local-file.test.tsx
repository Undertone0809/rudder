// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "../../context/ThemeContext";
import { RunTranscriptView } from "./RunTranscriptView";
import { TranscriptLocalFilePreview } from "./TranscriptLocalFilePreview";

Object.defineProperty(window, "matchMedia", {
  configurable: true,
  value: vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }),
});

const { openPath, readDesktopShell } = vi.hoisted(() => ({
  openPath: vi.fn(),
  readDesktopShell: vi.fn(),
}));

vi.mock("../../lib/desktop-shell", () => ({ readDesktopShell }));
vi.mock("../../context/OrganizationContext", () => ({
  useOptionalOrganization: () => ({ selectedOrganizationId: "org-1" }),
}));
vi.mock("../WorkspaceFilePreview", () => ({
  WorkspaceFilePreview: ({ file }: { file: { filePath: string; content: string | null } }) => (
    <section data-testid="authorized-file-preview">
      <h2>{file.filePath.split("/").at(-1)}</h2>
      <pre>{file.content}</pre>
    </section>
  ),
}));
vi.mock("../MarkdownEditor", () => ({ MarkdownEditor: () => null }));
vi.mock("../WorkspaceCodeEditor", () => ({ WorkspaceCodeEditor: () => null }));
vi.mock("@/components/chat/ResponseAnnotations", () => ({
  AnchoredResponseAnnotationMarkers: () => null,
  ResponseAnnotationEditor: () => null,
  SentResponseAnnotationsCard: () => null,
}));
vi.mock("@/components/chat/SelectionAnnotationToolbar", () => ({
  SelectionAnnotationToolbar: () => null,
}));
vi.mock("../MarkdownBody", () => ({
  MarkdownBody: ({
    children,
    onLinkClick,
  }: {
    children: string;
    onLinkClick?: (input: {
      event: React.MouseEvent<HTMLAnchorElement>;
      href: string;
      label: string;
    }) => boolean | void;
  }) => {
    const match = /\[([^\]]+)\]\(([^)]+)\)/u.exec(children);
    if (!match) return <div>{children}</div>;
    const [, label = "", href = ""] = match;
    return (
      <a
        href={href}
        onClick={(event) => onLinkClick?.({ event, href, label })}
      >
        {label}
      </a>
    );
  },
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
const restoreFns: Array<() => void> = [];
const localSkillFilePath = "/tmp/org-skills/review-helper/references/guide.md";

function LocalFilePreviewFlow({
  onOpenFile,
}: {
  onOpenFile: (targetPath: string, label: string) => void;
}) {
  const [target, setTarget] = useState<{ path: string; label: string } | null>(null);

  return (
    <>
      <RunTranscriptView
        entries={[{
          kind: "assistant",
          ts: "2026-09-29T00:00:00.000Z",
          text: `Review [the Skill guide](${localSkillFilePath})`,
        }]}
        onOpenFile={(path, label) => {
          onOpenFile(path, label);
          setTarget({ path, label });
        }}
      />
      {target ? (
        <TranscriptLocalFilePreview targetPath={target.path} label={target.label} />
      ) : null}
    </>
  );
}

async function render(onOpenFile: (targetPath: string, label: string) => void) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <ThemeProvider>
        <LocalFilePreviewFlow onOpenFile={onOpenFile} />
      </ThemeProvider>,
    );
  });
  return container;
}

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  for (const restore of restoreFns.splice(0)) restore();
  vi.clearAllMocks();
});

describe("RunTranscriptView local-file links", () => {
  it("reads a user-selected local file in the browser without a server request", async () => {
    readDesktopShell.mockReturnValue(null);
    const onOpenFile = vi.fn();
    const container = await render(onOpenFile);
    const link = container.querySelector<HTMLAnchorElement>(
      `a[href="${localSkillFilePath}"]`,
    );
    expect(link).not.toBeNull();

    await act(async () => {
      link?.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        button: 0,
      }));
    });

    expect(onOpenFile).toHaveBeenCalledWith(localSkillFilePath, "guide.md");
    expect(container.querySelector("[data-testid='chat-side-panel-local-file-picker']")?.textContent)
      .toContain("not sent to Rudder");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    restoreFns.push(() => fetchSpy.mockRestore());
    const fileInput = container.querySelector<HTMLInputElement>("input[type=file]");
    expect(fileInput).not.toBeNull();
    Object.defineProperty(fileInput, "files", {
      configurable: true,
      value: [new File(["# Local Skill guide"], "guide.md", { type: "text/markdown" })],
    });

    await act(async () => {
      fileInput?.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.querySelector("[data-testid='authorized-file-preview']")?.textContent)
      .toContain("Local Skill guide");
    expect(openPath).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("keeps the browser picker available after a mismatched file selection", async () => {
    readDesktopShell.mockReturnValue(null);
    const container = await render(vi.fn());
    const link = container.querySelector<HTMLAnchorElement>(
      `a[href="${localSkillFilePath}"]`,
    );
    await act(async () => {
      link?.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        button: 0,
      }));
    });
    const fileInput = container.querySelector<HTMLInputElement>("input[type=file]");
    expect(fileInput).not.toBeNull();
    Object.defineProperty(fileInput, "files", {
      configurable: true,
      value: [new File(["wrong file"], "other.md", { type: "text/markdown" })],
    });

    await act(async () => {
      fileInput?.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("guide.md");
    expect(container.querySelector("button")?.textContent).toContain("Choose local file");
  });
});
