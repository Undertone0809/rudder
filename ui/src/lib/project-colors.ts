import type { CSSProperties } from "react";

const DEFAULT_PROJECT_COLOR = "linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)";
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const HEX_COLOR_SHORT_RE = /^#[0-9a-fA-F]{3}$/;
const PROJECT_GRADIENT_RE = /^linear-gradient\(\s*(?:\d{1,3}deg|to\s+(?:top|bottom|left|right)(?:\s+(?:top|bottom|left|right))?)\s*,\s*#[0-9a-fA-F]{6}(?:\s+\d{1,3}%?)?\s*,\s*#[0-9a-fA-F]{6}(?:\s+\d{1,3}%?)?\s*\)$/;

function expandShortHex(color: string) {
  const raw = color.slice(1).toLowerCase();
  return `#${raw[0]}${raw[0]}${raw[1]}${raw[1]}${raw[2]}${raw[2]}`;
}

export function normalizeProjectColor(color: string | null | undefined, fallback = DEFAULT_PROJECT_COLOR) {
  const value = color?.trim();
  if (!value) return fallback;
  if (HEX_COLOR_RE.test(value)) return value.toLowerCase();
  if (HEX_COLOR_SHORT_RE.test(value)) return expandShortHex(value);
  if (PROJECT_GRADIENT_RE.test(value)) return value;
  return fallback;
}

export function projectColorBackgroundStyle(color: string | null | undefined): CSSProperties {
  return {
    background: normalizeProjectColor(color),
  };
}

export function projectColorAccent(color: string | null | undefined) {
  const normalized = normalizeProjectColor(color);
  const hex = normalized.match(/#[0-9a-fA-F]{6}/)?.[0];
  return hex?.toLowerCase() ?? "#6366f1";
}

export function projectColorCssVars(color: string | null | undefined): CSSProperties {
  return {
    "--project-color": normalizeProjectColor(color),
    "--project-accent-color": projectColorAccent(color),
  } as CSSProperties;
}
