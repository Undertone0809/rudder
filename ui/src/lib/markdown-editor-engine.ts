export type MarkdownEditorEngine = "legacy" | "milkdown" | "codemirror";

export function resolveMarkdownEditorEngine({
  plainText,
  engine,
}: {
  plainText?: boolean;
  engine?: MarkdownEditorEngine;
}): MarkdownEditorEngine {
  if (plainText) return "legacy";
  return engine ?? "legacy";
}
