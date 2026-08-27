type FragmentMarkdownOptions = {
  bareListKind?: "ordered" | "unordered";
  bareListStart?: number;
};

function canonicalMarkdownLink(label: string, href: string) {
  return `[${label}](${href})`;
}

function escapeInlineCode(value: string) {
  return value.replace(/`/g, "\\`");
}

export function readCanonicalFragmentMarkdown(
  fragment: DocumentFragment,
  options: FragmentMarkdownOptions = {},
) {
  const normalize = (value: string) => value
    .replace(/\u200B/g, "")
    .replace(/\u00A0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  function readInline(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    if (node instanceof HTMLBRElement) return "\n";
    if (node instanceof HTMLAnchorElement) {
      const label = node.textContent ?? "";
      const href = node.getAttribute("href") ?? "";
      if (href) return canonicalMarkdownLink(label, href);
    }
    if (node instanceof HTMLElement) {
      const tokenHref = node.dataset.skillHref ?? node.dataset.mentionHref ?? "";
      if (tokenHref && (node.dataset.skillToken === "true" || node.dataset.mentionKind)) {
        return canonicalMarkdownLink(node.textContent ?? "", tokenHref);
      }
    }
    if (node instanceof HTMLElement && node.tagName === "CODE" && !(node.parentElement instanceof HTMLPreElement)) {
      return `\`${escapeInlineCode(node.textContent ?? "")}\``;
    }
    if (node instanceof HTMLElement && (node.tagName === "STRONG" || node.tagName === "B")) {
      return `**${Array.from(node.childNodes).map(readInline).join("")}**`;
    }
    if (node instanceof HTMLElement && (node.tagName === "EM" || node.tagName === "I")) {
      return `*${Array.from(node.childNodes).map(readInline).join("")}*`;
    }
    if (node instanceof HTMLUListElement || node instanceof HTMLOListElement) {
      return `\n${readList(node, 0)}\n`;
    }
    if (node instanceof HTMLLIElement) {
      const marker = options.bareListKind === "ordered" ? `${bareListOrdinal}.` : "-";
      bareListOrdinal += 1;
      return `${readListItem(node, marker, 0)}\n`;
    }
    if (node instanceof HTMLParagraphElement || node instanceof HTMLDivElement) {
      return `${Array.from(node.childNodes).map(readInline).join("")}\n`;
    }
    return Array.from(node.childNodes).map(readInline).join("");
  }

  function readListItem(item: HTMLLIElement, marker: string, indentLevel: number) {
    const indent = "  ".repeat(indentLevel);
    const nestedLists: string[] = [];
    const bodyParts: string[] = [];
    for (const child of Array.from(item.childNodes)) {
      if (child instanceof HTMLUListElement || child instanceof HTMLOListElement) {
        nestedLists.push(readList(child, indentLevel + 1));
        continue;
      }
      bodyParts.push(readInline(child));
    }
    const body = normalize(bodyParts.join(""));
    const lines = body ? body.split("\n") : [""];
    const rendered = [`${indent}${marker} ${lines[0] ?? ""}`.trimEnd()];
    for (const line of lines.slice(1)) rendered.push(`${indent}  ${line}`.trimEnd());
    for (const nested of nestedLists) {
      if (nested.trim()) rendered.push(nested);
    }
    return rendered.join("\n");
  }

  function readList(list: HTMLUListElement | HTMLOListElement, indentLevel: number) {
    const ordered = list instanceof HTMLOListElement;
    const start = Number.parseInt(list.getAttribute("start") ?? "1", 10);
    let ordinal = Number.isFinite(start) ? start : 1;
    const items: string[] = [];
    for (const child of Array.from(list.children)) {
      if (!(child instanceof HTMLLIElement)) continue;
      const marker = ordered ? `${ordinal}.` : "-";
      items.push(readListItem(child, marker, indentLevel));
      ordinal += 1;
    }
    return items.join("\n");
  }

  let bareListOrdinal = options.bareListStart ?? 1;
  return normalize(Array.from(fragment.childNodes).map(readInline).join(""));
}

export function shouldCopySelectionAsMarkdown(visibleSelectionText: string) {
  const normalized = visibleSelectionText
    .replace(/\r\n?/g, "\n")
    .replace(/\u200B/g, "")
    .replace(/\u00A0/g, " ")
    .trim();
  if (!normalized) return false;
  return normalized.split("\n").some((line, index) => index > 0 && line.trim().length > 0);
}
