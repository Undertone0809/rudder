// @vitest-environment jsdom

import type { OrganizationWorkspaceFileDetail } from "@rudderhq/shared";
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

const { openPath, readDesktopShell, readAuthorizedLocalFilePreview } = vi.hoisted(() => ({
  openPath: vi.fn(),
  readDesktopShell: vi.fn(),
  readAuthorizedLocalFilePreview: vi.fn(),
}));

vi.mock("../../lib/desktop-shell", () => ({ readDesktopShell }));
vi.mock("../../api/localFiles", () => ({ readAuthorizedLocalFilePreview }));
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
  vi.clearAllMocks();
});

describe("RunTranscriptView local-file links", () => {
  it("opens the authorized Skill preview from an ordinary browser click", async () => {
    readDesktopShell.mockReturnValue(null);
    readAuthorizedLocalFilePreview.mockResolvedValue({
      source: "org_root",
      rootPath: "/tmp/org-skills/review-helper",
      repoUrl: null,
      filePath: "references/guide.md",
      libraryEntryId: null,
      mentionHref: null,
      markdownLink: null,
      rootExists: true,
      content: "# Authorized Skill guide",
      contentType: "text/markdown",
      previewKind: "text",
      contentPath: null,
      message: null,
      truncated: false,
    } satisfies OrganizationWorkspaceFileDetail);
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
    expect(readAuthorizedLocalFilePreview).toHaveBeenCalledWith("org-1", localSkillFilePath);
    expect(container.querySelector("[data-testid='authorized-file-preview']")?.textContent)
      .toContain("Authorized Skill guide");
    expect(openPath).not.toHaveBeenCalled();
  });
});
