// @vitest-environment jsdom

import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunTranscriptView } from "./RunTranscriptView";
import { TranscriptChatToolActionRow } from "./RunTranscriptView.chat";
import { normalizeTranscript } from "./RunTranscriptView.normalize";
import { createTranscriptFileTargets, describeToolSemanticInfo } from "./RunTranscriptView.semantic";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { previewLocalFile, readDesktopShell } = vi.hoisted(() => ({
  previewLocalFile: vi.fn(),
  readDesktopShell: vi.fn(),
}));

vi.mock("../../lib/desktop-shell", () => ({ readDesktopShell }));
vi.mock("../InspectableImage", () => ({
  InspectableImage: ({ src, name }: { src: string; name: string }) => (
    <button type="button" data-testid="inspectable-image" data-src={src}>{name}</button>
  ),
}));

const roots: Root[] = [];

async function renderRow(
  block: Parameters<typeof TranscriptChatToolActionRow>[0]["block"],
  onOpenFile = vi.fn(),
  strict = false,
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    const row = (
      <TranscriptChatToolActionRow
        block={block}
        density="compact"
        onOpenFile={onOpenFile}
      />
    );
    root.render(strict ? <StrictMode>{row}</StrictMode> : row);
  });
  return { container, onOpenFile };
}

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe("transcript artifact semantics", () => {
  it("uses cross-platform basenames while retaining trusted paths", () => {
    expect(createTranscriptFileTargets([
      "/workspace/src/RunTranscriptView.tsx",
      "ui\\src\\WindowsView.tsx",
      "README.md",
    ], { cwd: "/workspace" })).toEqual([
      {
        displayLabel: "RunTranscriptView.tsx",
        label: "/workspace/src/RunTranscriptView.tsx",
        path: "/workspace/src/RunTranscriptView.tsx",
      },
      {
        displayLabel: "WindowsView.tsx",
        label: "ui\\src\\WindowsView.tsx",
        path: "/workspace/ui/src/WindowsView.tsx",
      },
      {
        displayLabel: "README.md",
        label: "README.md",
        path: "/workspace/README.md",
      },
    ]);
  });

  it("makes SKILL.md reads inspectable with the skill slug as the display label", () => {
    const semantic = describeToolSemanticInfo("command_execution", {
      command: "sed -n '1,240p' .agents/skills/systematic-debugging/SKILL.md",
      cwd: "/workspace",
    });

    expect(semantic).toMatchObject({
      actionKind: "skill",
      category: "skill",
      summary: "Use systematic-debugging skill",
      fileTargets: [{
        displayLabel: "systematic-debugging",
        label: ".agents/skills/systematic-debugging/SKILL.md",
        path: "/workspace/.agents/skills/systematic-debugging/SKILL.md",
      }],
    });
  });

  it("does not expose untrusted relative targets as Side Panel actions", () => {
    expect(createTranscriptFileTargets(["README.md"], null)).toEqual([
      {
        displayLabel: "README.md",
        label: "README.md",
        path: null,
      },
    ]);
  });

  it("models image and immutable file-change evidence without reading current files", () => {
    expect(describeToolSemanticInfo("image_view", {
      id: "image-1",
      status: "completed",
      path: "/tmp/screens/dashboard.png",
    })).toMatchObject({
      actionKind: "image_view",
      category: "image",
      summary: "Viewed an image",
      image: {
        displayLabel: "dashboard.png",
        path: "/tmp/screens/dashboard.png",
      },
    });

    expect(describeToolSemanticInfo("file_change", {
      id: "change-1",
      status: "completed",
      changes: [{
        path: "/workspace/src/example.ts",
        kind: { type: "update", move_path: null },
        diff: "@@ -1 +1 @@\n-old\n+new",
        diff_truncated: true,
        diff_original_bytes: 400_000,
      }],
    })).toMatchObject({
      actionKind: "file_change",
      summary: "Edited 1 file",
      fileChanges: [{
        displayLabel: "example.ts",
        path: "/workspace/src/example.ts",
        operation: "update",
        additions: 1,
        deletions: 1,
        diffTruncated: true,
        diffOriginalBytes: 400_000,
      }],
    });
  });

  it("does not invent a file count when file-change evidence is empty or failed", () => {
    expect(describeToolSemanticInfo("file_change", {
      status: "completed",
      changes: [],
    }).summary).toBe("File changes");
    expect(describeToolSemanticInfo("file_change", {
      status: "failed",
      changes: [],
    }).summary).toBe("File change failed");
  });

  it("uses the original file count when bounded evidence retains fewer rows", () => {
    expect(describeToolSemanticInfo("file_change", {
      status: "completed",
      changes: [{
        path: "/workspace/retained.ts",
        kind: "update",
        diff: "@@ -1 +1 @@\n-old\n+new",
      }],
      truncation: {
        truncated: true,
        original_file_count: 120,
        retained_file_count: 1,
        omitted_file_count: 119,
      },
    })).toMatchObject({
      summary: "Edited 120 files",
      quantity: 120,
    });
  });
});

describe("transcript artifact row interactions", () => {
  it("keeps artifact opening separate from raw detail disclosure", async () => {
    const { container, onOpenFile } = await renderRow({
      ts: "2026-07-24T00:00:00.000Z",
      endTs: "2026-07-24T00:00:01.000Z",
      name: "read",
      input: { path: "/workspace/src/example.ts" },
      result: "contents",
      status: "completed",
    });

    const fileButton = container.querySelector<HTMLButtonElement>("[data-transcript-file-target]");
    expect(fileButton?.textContent).toBe("example.ts");

    await act(async () => fileButton?.click());
    expect(onOpenFile).toHaveBeenCalledWith("/workspace/src/example.ts", "example.ts");
    expect(container.textContent).not.toContain("Input");

    const disclosure = container.querySelector<HTMLButtonElement>("[data-transcript-action-row-disclosure='true']");
    const disclosureLabels = disclosure?.getAttribute("aria-labelledby")
      ?.split(/\s+/u)
      .map((id) => document.getElementById(id)?.textContent?.trim())
      .filter(Boolean)
      .join(" ");
    expect(disclosureLabels).toContain("Read example.ts");
    expect(disclosureLabels).not.toContain("/workspace/src/example.ts");
    await act(async () => disclosure?.click());
    expect(container.textContent).toContain("Input");
    expect(onOpenFile).toHaveBeenCalledTimes(1);
  });

  it("expands each historical text diff inline and never opens the current file", async () => {
    const { container, onOpenFile } = await renderRow({
      ts: "2026-07-24T00:00:00.000Z",
      endTs: "2026-07-24T00:00:01.000Z",
      name: "file_change",
      input: {
        status: "completed",
        changes: [{
          path: "/workspace/src/example.ts",
          kind: "update",
          diff: "@@ -1 +1 @@\n-<script>old()</script>\n+safe()",
        }],
      },
      result: "{}",
      status: "completed",
    });

    const diffButton = container.querySelector<HTMLButtonElement>("[data-transcript-diff-target]");
    expect(diffButton?.textContent).toContain("example.ts +1 -1");
    await act(async () => diffButton?.click());

    expect(onOpenFile).not.toHaveBeenCalled();
    expect(container.textContent).toContain("<script>old()</script>");
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("[aria-label='Copy diff for example.ts']")).not.toBeNull();
  });

  it.each([
    ["failed", { status: "failed", changes: [{ path: "/workspace/fail.ts", kind: "update", diff: "@@ -1 +1 @@\n-a\n+b" }] }],
    ["missing", { status: "completed", changes: [{ path: "/workspace/missing.ts", kind: "update" }] }],
    ["binary", { status: "completed", changes: [{ path: "/workspace/logo.png", kind: "update", diff: "Binary files a/logo.png and b/logo.png differ" }] }],
  ])("does not fabricate an inline diff for %s evidence", async (_caseName, input) => {
    const { container } = await renderRow({
      ts: "2026-07-24T00:00:00.000Z",
      endTs: "2026-07-24T00:00:01.000Z",
      name: "file_change",
      input,
      result: "{}",
      status: _caseName === "failed" ? "error" : "completed",
    });

    expect(container.querySelector("[data-transcript-diff-target]")).toBeNull();
    expect(container.querySelector("[data-transcript-action-row-disclosure='true']")).not.toBeNull();
  });

  it("loads a local image only after explicit artifact expansion", async () => {
    readDesktopShell.mockReturnValue({ previewLocalFile });
    previewLocalFile.mockResolvedValue({
      canonicalPath: "/private/tmp/dashboard.png",
      fileName: "dashboard.png",
      parentPath: "/private/tmp",
      contentType: "image/png",
      previewKind: "image",
      content: null,
      base64: "aW1hZ2U=",
      sizeBytes: 5,
      modifiedAt: "2026-07-24T00:00:00.000Z",
      truncated: false,
    });

    const { container } = await renderRow({
      ts: "2026-07-24T00:00:00.000Z",
      endTs: "2026-07-24T00:00:01.000Z",
      name: "image_view",
      input: { status: "completed", path: "/tmp/dashboard.png" },
      result: "{}",
      status: "completed",
    }, vi.fn(), true);

    expect(previewLocalFile).not.toHaveBeenCalled();
    expect(container.querySelector("[data-transcript-action-icon='image']")).not.toBeNull();
    await act(async () => {
      container.querySelector<HTMLButtonElement>("[data-transcript-image-target]")?.click();
      await Promise.resolve();
    });
    expect(previewLocalFile).toHaveBeenCalledWith("/tmp/dashboard.png");
    expect(previewLocalFile).toHaveBeenCalledTimes(1);
    expect(container.querySelector("[data-testid='inspectable-image']")?.getAttribute("data-src"))
      .toBe("data:image/png;base64,aW1hZ2U=");
  });

  it("reveals top-level truncation evidence explicitly without fabricating a file row", async () => {
    const { container } = await renderRow({
      ts: "2026-07-24T00:00:00.000Z",
      endTs: "2026-07-24T00:00:01.000Z",
      name: "file_change",
      input: {
        status: "completed",
        changes: [],
        truncation: {
          omitted_file_count: 3,
          max_bytes: 262_144,
          truncated_diff_count: 2,
        },
      },
      result: "{}",
      status: "completed",
    });

    expect(container.textContent).toContain("File changes");
    expect(container.querySelector("[data-transcript-diff-target]")).toBeNull();
    expect(container.querySelector("[data-transcript-evidence-warning]")).toBeNull();

    await act(async () => {
      container.querySelector<HTMLButtonElement>("[data-transcript-action-row-disclosure='true']")?.click();
    });
    expect(container.querySelector("[data-transcript-evidence-warning]")?.textContent)
      .toContain("3 files omitted");
    expect(container.querySelector("[data-transcript-evidence-warning]")?.textContent)
      .toContain("262,144-byte evidence limit");
    expect(container.querySelector("[data-transcript-evidence-warning]")?.textContent)
      .toContain("2 diffs truncated");
  });

  it.each([
    ["read", {
      paths: ["/workspace/src/one.ts", "/workspace/src/two.ts"],
    }, "Read 2 files"],
    ["file_change", {
      status: "completed",
      changes: [
        { path: "/workspace/src/one.ts", kind: "update", diff: "@@ -1 +1 @@\n-a\n+b" },
        { path: "/workspace/src/two.ts", kind: "update", diff: "@@ -1 +1 @@\n-c\n+d" },
      ],
    }, "Edited 2 files"],
  ])("keeps a multi-target %s tool compact until its group is expanded", async (name, input, summary) => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        <RunTranscriptView
          density="compact"
          presentation="chat"
          entries={[
            { kind: "system", ts: "2026-07-24T00:00:00.000Z", text: "turn started" },
            { kind: "tool_call", ts: "2026-07-24T00:00:01.000Z", name, toolUseId: `${name}-1`, input },
            { kind: "tool_result", ts: "2026-07-24T00:00:02.000Z", toolUseId: `${name}-1`, content: JSON.stringify(input), isError: false },
          ]}
        />,
      );
    });

    expect(container.textContent).toContain(summary);
    expect(container.querySelector("[data-transcript-file-target], [data-transcript-diff-target]")).toBeNull();

    await act(async () => {
      container.querySelector<HTMLButtonElement>("[data-testid='transcript-action-group-disclosure']")?.click();
    });
    expect(container.querySelectorAll(
      name === "read" ? "[data-transcript-file-target]" : "[data-transcript-diff-target]",
    )).toHaveLength(2);
  });

  it("keeps repeated edits to one path as independent historical diff records", async () => {
    const inputOne = {
      status: "completed",
      changes: [{ path: "/workspace/src/repeated.ts", kind: "update", diff: "@@ -1 +1 @@\n-one\n+two" }],
    };
    const inputTwo = {
      status: "completed",
      changes: [{ path: "/workspace/src/repeated.ts", kind: "update", diff: "@@ -1 +1 @@\n-two\n+three" }],
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        <RunTranscriptView
          density="compact"
          presentation="chat"
          entries={[
            { kind: "system", ts: "2026-07-24T00:00:00.000Z", text: "turn started" },
            { kind: "tool_call", ts: "2026-07-24T00:00:01.000Z", name: "file_change", toolUseId: "edit-1", input: inputOne },
            { kind: "tool_result", ts: "2026-07-24T00:00:02.000Z", toolUseId: "edit-1", content: JSON.stringify(inputOne), isError: false },
            { kind: "tool_call", ts: "2026-07-24T00:00:03.000Z", name: "file_change", toolUseId: "edit-2", input: inputTwo },
            { kind: "tool_result", ts: "2026-07-24T00:00:04.000Z", toolUseId: "edit-2", content: JSON.stringify(inputTwo), isError: false },
          ]}
        />,
      );
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>("[data-testid='transcript-action-group-disclosure']")?.click();
    });
    const buttons = container.querySelectorAll<HTMLButtonElement>("[data-transcript-diff-target]");
    expect(buttons).toHaveLength(2);
    await act(async () => buttons[1]?.click());
    expect(container.textContent).toContain("-two");
    expect(container.textContent).toContain("+three");
    expect(container.textContent).not.toContain("-one");
  });

  it("keeps image copy explicit in a mixed compact action summary", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        <RunTranscriptView
          density="compact"
          presentation="chat"
          entries={[
            { kind: "system", ts: "2026-07-24T00:00:00.000Z", text: "turn started" },
            {
              kind: "tool_call",
              ts: "2026-07-24T00:00:01.000Z",
              name: "image_view",
              toolUseId: "image-1",
              input: { status: "completed", path: "/workspace/preview.png" },
            },
            {
              kind: "tool_result",
              ts: "2026-07-24T00:00:02.000Z",
              toolUseId: "image-1",
              content: JSON.stringify({ status: "completed", path: "/workspace/preview.png" }),
              isError: false,
            },
            {
              kind: "tool_call",
              ts: "2026-07-24T00:00:03.000Z",
              name: "read",
              toolUseId: "read-1",
              input: { path: "/workspace/source.ts" },
            },
            {
              kind: "tool_result",
              ts: "2026-07-24T00:00:04.000Z",
              toolUseId: "read-1",
              content: "source",
              isError: false,
            },
          ]}
        />,
      );
    });

    expect(container.textContent).toContain("Viewed an image");
    expect(container.textContent).toContain("read 1 file");
    expect(container.textContent).not.toContain("Explored 1 item");
  });

  it("keeps a truncated single retained edit behind its original-count summary", async () => {
    const evidence = {
      status: "completed",
      changes: [{
        path: "/workspace/retained.ts",
        kind: "update",
        diff: "@@ -1 +1 @@\n-old\n+new",
      }],
      truncation: {
        truncated: true,
        original_file_count: 120,
        retained_file_count: 1,
        omitted_file_count: 119,
      },
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        <RunTranscriptView
          density="compact"
          presentation="chat"
          entries={[
            { kind: "system", ts: "2026-07-24T00:00:00.000Z", text: "turn started" },
            { kind: "tool_call", ts: "2026-07-24T00:00:01.000Z", name: "file_change", toolUseId: "edit-1", input: evidence },
            { kind: "tool_result", ts: "2026-07-24T00:00:02.000Z", toolUseId: "edit-1", content: JSON.stringify(evidence), isError: false },
          ]}
        />,
      );
    });

    expect(container.textContent).toContain("Edited 120 files");
    expect(container.querySelector("[data-transcript-diff-target]")).toBeNull();
    await act(async () => {
      container.querySelector<HTMLButtonElement>("[data-testid='transcript-action-group-disclosure']")?.click();
    });
    expect(container.querySelector("[data-transcript-diff-target]")).not.toBeNull();
  });

  it("forwards file actions through the detail presentation", async () => {
    const onOpenFile = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        <RunTranscriptView
          density="compact"
          presentation="detail"
          onOpenFile={onOpenFile}
          entries={[
            { kind: "system", ts: "2026-07-24T00:00:00.000Z", text: "turn started" },
            { kind: "tool_call", ts: "2026-07-24T00:00:01.000Z", name: "read", toolUseId: "read-1", input: { path: "/workspace/src/detail.ts" } },
            { kind: "tool_result", ts: "2026-07-24T00:00:02.000Z", toolUseId: "read-1", content: "contents", isError: false },
          ]}
        />,
      );
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>("[data-transcript-file-target]")?.click();
    });
    expect(onOpenFile).toHaveBeenCalledWith("/workspace/src/detail.ts", "detail.ts");
  });
});

describe("completed-only artifact evidence", () => {
  it.each(["image_view", "file_change"])("hydrates %s input from trusted JSON tool results", (toolName) => {
    const evidence = toolName === "image_view"
      ? { status: "completed", path: "/tmp/image.png" }
      : { status: "completed", changes: [{ path: "/tmp/file.ts", kind: "update", diff: "@@ -1 +1 @@\n-a\n+b" }] };
    const blocks = normalizeTranscript([{
      kind: "tool_result",
      ts: "2026-07-24T00:00:00.000Z",
      toolUseId: `${toolName}-1`,
      toolName,
      content: JSON.stringify(evidence),
      isError: false,
    }], false);

    expect(blocks[0]).toMatchObject({
      type: "tool",
      name: toolName,
      input: evidence,
      status: "completed",
    });
  });
});
