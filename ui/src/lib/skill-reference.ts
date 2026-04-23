export interface ParsedSkillReference {
  href: string;
  label: string;
}

function normalizeSkillReferenceLabel(value: string | null | undefined) {
  const trimmed = value?.trim() ?? "";
  return trimmed.replace(/^\$/u, "").trim();
}

function stripUrlDecoration(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const withoutHash = trimmed.split("#", 1)[0] ?? trimmed;
  return withoutHash.split("?", 1)[0] ?? withoutHash;
}

export function isMarkdownSkillPath(value: string) {
  const normalized = stripUrlDecoration(value).replace(/\/+$/u, "");
  if (!normalized) return false;
  return normalized.endsWith("/SKILL.md") || normalized.toLowerCase().endsWith(".md");
}

function isCanonicalSkillMarkdownPath(value: string) {
  const normalized = stripUrlDecoration(value).replace(/\/+$/u, "");
  return normalized.endsWith("/SKILL.md");
}

function isSkillReferenceLabel(value: string) {
  return /^[a-z0-9._-]+(?:\/[a-z0-9._-]+)+$/iu.test(value);
}

export function parseSkillReference(href: string | null | undefined, label: string | null | undefined): ParsedSkillReference | null {
  const rawLabel = label?.trim() ?? "";
  const normalizedLabel = normalizeSkillReferenceLabel(rawLabel);
  const normalizedHref = href?.trim() ?? "";
  if (!normalizedLabel || !isSkillReferenceLabel(normalizedLabel)) return null;
  if (!rawLabel.startsWith("$") && !isCanonicalSkillMarkdownPath(normalizedHref)) return null;
  if (rawLabel.startsWith("$") && !isMarkdownSkillPath(normalizedHref)) return null;
  return {
    href: normalizedHref,
    label: normalizedLabel,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function removeSkillReferenceFromMarkdown(markdown: string, label: string) {
  const normalizedMarkdown = markdown.replace(/\r\n/g, "\n");
  const normalizedLabel = normalizeSkillReferenceLabel(label);
  if (!normalizedLabel) return markdown;

  const referencePattern = new RegExp(
    String.raw`\[(?:\$)?${escapeRegExp(normalizedLabel)}\]\(([^)\n]+(?:\/SKILL\.md|\.md))\)`,
    "u",
  );
  const nextMarkdown = normalizedMarkdown.replace(referencePattern, "");
  if (nextMarkdown === normalizedMarkdown) return markdown;

  return nextMarkdown
    .replace(/[ \t\u00A0]+\n/g, "\n")
    .replace(/\n[ \t\u00A0]+\n/g, "\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^[\s\u00A0]+|[\s\u00A0]+$/g, "");
}

export function applySkillTokenDecoration(element: HTMLElement) {
  element.dataset.skillToken = "true";
  element.setAttribute("contenteditable", "false");
  element.setAttribute("tabindex", "-1");
  element.setAttribute("draggable", "false");
  element.classList.add("rudder-skill-token");
}

export function clearSkillTokenDecoration(element: HTMLElement) {
  delete element.dataset.skillToken;
  element.removeAttribute("contenteditable");
  element.removeAttribute("tabindex");
  element.removeAttribute("draggable");
  element.classList.remove("rudder-skill-token");
}
