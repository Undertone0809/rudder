import { useEffect } from "react";
import type { InstanceLocale } from "@rudderhq/shared";
import { translateLegacyString } from "@/i18n/legacyPhrases";

type TextRecord = {
  source: string;
  rendered: string;
};

const TEXT_ATTRIBUTES = ["placeholder", "title", "aria-label"] as const;
const EXCLUDED_SELECTOR = [
  "code",
  "pre",
  "script",
  "style",
  "textarea",
  "[contenteditable='true']",
  ".cm-editor",
  ".cm-content",
  ".mdxeditor",
  "[data-i18n-ignore='true']",
].join(", ");

const textRecords = new WeakMap<Text, TextRecord>();
const attributeRecords = new WeakMap<Element, Map<string, TextRecord>>();

function shouldSkip(element: Element | null) {
  if (!element) return true;
  return element.closest(EXCLUDED_SELECTOR) != null;
}

function syncTextNode(node: Text, locale: InstanceLocale) {
  const parent = node.parentElement;
  if (!parent || shouldSkip(parent)) return;

  const current = node.textContent ?? "";
  let record = textRecords.get(node);
  if (!record) {
    record = { source: current, rendered: current };
    textRecords.set(node, record);
  } else if (current !== record.rendered && current !== record.source) {
    record.source = current;
  }

  const next = translateLegacyString(locale, record.source);
  record.rendered = next;
  if (current !== next) {
    node.textContent = next;
  }
}

function syncAttribute(element: Element, attribute: (typeof TEXT_ATTRIBUTES)[number], locale: InstanceLocale) {
  if (!element.hasAttribute(attribute) || shouldSkip(element)) return;

  const current = element.getAttribute(attribute) ?? "";
  let elementMap = attributeRecords.get(element);
  if (!elementMap) {
    elementMap = new Map();
    attributeRecords.set(element, elementMap);
  }

  let record = elementMap.get(attribute);
  if (!record) {
    record = { source: current, rendered: current };
    elementMap.set(attribute, record);
  } else if (current !== record.rendered && current !== record.source) {
    record.source = current;
  }

  const next = translateLegacyString(locale, record.source);
  record.rendered = next;
  if (current !== next) {
    element.setAttribute(attribute, next);
  }
}

function walk(node: Node, locale: InstanceLocale) {
  if (node.nodeType === Node.TEXT_NODE) {
    syncTextNode(node as Text, locale);
    return;
  }

  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const element = node as Element;
  for (const attribute of TEXT_ATTRIBUTES) {
    syncAttribute(element, attribute, locale);
  }
  for (const child of Array.from(element.childNodes)) {
    walk(child, locale);
  }
}

export function LegacyI18nBridge({ locale }: { locale: InstanceLocale }) {
  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.body;
    if (!root) return;

    walk(root, locale);

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "characterData") {
          syncTextNode(mutation.target as Text, locale);
          continue;
        }

        if (mutation.type === "attributes") {
          syncAttribute(mutation.target as Element, mutation.attributeName as (typeof TEXT_ATTRIBUTES)[number], locale);
          continue;
        }

        for (const node of Array.from(mutation.addedNodes)) {
          walk(node, locale);
        }
      }
    });

    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [...TEXT_ATTRIBUTES],
    });

    return () => observer.disconnect();
  }, [locale]);

  return null;
}
