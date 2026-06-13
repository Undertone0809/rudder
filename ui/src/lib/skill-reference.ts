import { Boxes } from "lucide-react";
import type { CSSProperties } from "react";
import { buildLucideIconMask } from "./mention-chips";

export interface ParsedSkillReference {
  href: string;
  label: string;
}

function normalizeSkillReferenceLabel(value: string | null | undefined) {
  const trimmed = value?.trim() ?? "";
  return trimmed.replace(/^\$/u, "").trim();
}

export function formatSkillReferenceDisplayLabel(value: string | null | undefined) {
  const normalized = normalizeSkillReferenceLabel(value);
  if (!normalized) return "";
  const parts = normalized.split("/").filter(Boolean);
  return parts.at(-1) ?? normalized;
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
  return /^[a-z0-9._-]+(?:\/[a-z0-9._-]+)*$/iu.test(value);
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
    label: formatSkillReferenceDisplayLabel(normalizedLabel),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function removeSkillReferenceFromMarkdown(markdown: string, label: string) {
  const normalizedMarkdown = markdown.replace(/\r\n/g, "\n");
  const normalizedLabel = normalizeSkillReferenceLabel(label);
  if (!normalizedLabel) return markdown;
  const labelPattern = normalizedLabel.includes("/")
    ? escapeRegExp(normalizedLabel)
    : String.raw`(?:[a-z0-9._-]+\/)*${escapeRegExp(normalizedLabel)}`;

  const referencePattern = new RegExp(
    String.raw`\[(?:\$)?${labelPattern}\]\(([^)\n]+(?:\/SKILL\.md|\.md))\)`,
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

export function applySkillTokenDecoration(element: HTMLElement, href?: string | null) {
  element.dataset.skillToken = "true";
  if (href) {
    element.dataset.skillHref = href;
  }
  element.setAttribute("contenteditable", "false");
  element.setAttribute("tabindex", "-1");
  element.setAttribute("draggable", "false");
  element.classList.add("rudder-skill-token");
  const style = skillTokenIconInlineStyle();
  if (style["--rudder-skill-icon-mask"]) {
    element.style.setProperty("--rudder-skill-icon-mask", style["--rudder-skill-icon-mask"]);
  }
}

export function clearSkillTokenDecoration(element: HTMLElement) {
  delete element.dataset.skillToken;
  delete element.dataset.skillHref;
  element.removeAttribute("contenteditable");
  element.removeAttribute("tabindex");
  element.removeAttribute("draggable");
  element.classList.remove("rudder-skill-token");
  element.style.removeProperty("--rudder-skill-icon-mask");
}

export function skillTokenIconInlineStyle(): CSSProperties & Record<string, string> {
  const iconMask = buildLucideIconMask(Boxes, "lucide:boxes");
  return iconMask ? ({ "--rudder-skill-icon-mask": iconMask } as CSSProperties & Record<string, string>) : {};
}
