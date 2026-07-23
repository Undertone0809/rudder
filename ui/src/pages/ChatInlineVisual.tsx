import { MarkdownBody } from "@/components/MarkdownBody";
import { useTheme } from "@/context/ThemeContext";
import { CHAT_ANNOTATION_IGNORE_ATTRIBUTE } from "@/lib/chat-response-annotation-selection";
import {
  MAX_RUDDER_INLINE_VISUAL_FRAGMENT_BYTES,
  chatInlineVisualMappingsFromStructuredPayload,
  parseCodexInlineVisualDirectives,
  parseRudderInlineVisualPlacements,
  rudderInlineVisualMappingsFromStructuredPayload,
  type ChatAttachment,
  type ChatMessage,
} from "@rudderhq/shared";
import {
  generate as generateCss,
  parse as parseCss,
  walk as walkCss,
  type CssNode,
} from "css-tree";
import createDOMPurify from "dompurify";
import { AlertTriangle } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ComponentProps } from "react";

export const INLINE_VISUAL_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  "font-src 'none'",
  "img-src 'none'",
  "connect-src 'none'",
  "media-src 'none'",
  "child-src 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
].join("; ");

const VISUAL_RUNTIME_CSS = String.raw`
:root{color-scheme:light dark;--background:light-dark(rgb(255 255 255),rgb(24 24 24));--foreground:light-dark(rgb(26 28 31),rgb(255 255 255));--card:color-mix(in oklab,var(--foreground) 5%,transparent);--card-foreground:var(--foreground);--popover:light-dark(rgb(255 255 255),rgb(45 45 45));--popover-foreground:var(--foreground);--primary:light-dark(rgb(39 122 91),rgb(91 184 148));--primary-foreground:light-dark(rgb(255 255 255),rgb(13 13 13));--secondary:light-dark(rgb(247 247 246),rgb(54 54 54));--secondary-foreground:var(--foreground);--muted:color-mix(in srgb,var(--foreground) 10%,transparent);--muted-foreground:light-dark(rgb(26 28 31/58%),rgb(255 255 255/58%));--accent:light-dark(rgb(231 240 236),rgb(26 58 46));--accent-foreground:var(--primary);--destructive:light-dark(rgb(190 55 44),rgb(255 125 110));--border:light-dark(rgb(26 28 31/12%),rgb(255 255 255/12%));--input:light-dark(rgb(26 28 31/16%),rgb(255 255 255/18%));--ring:var(--primary);--font-size-base:14px;--viz-series-1:var(--primary);--viz-series-2:light-dark(rgb(226 130 52),rgb(241 158 89));--viz-series-3:light-dark(rgb(64 142 196),rgb(104 177 226));--viz-series-4:light-dark(rgb(199 91 142),rgb(231 137 182));--viz-series-5:light-dark(rgb(119 99 194),rgb(164 146 224));--viz-series-6:light-dark(rgb(47 151 148),rgb(91 194 189));--font-sans:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--font-mono:ui-monospace,SFMono-Regular,Menlo,monospace;--radius:8px}
:root[data-theme="light"]{color-scheme:light}:root[data-theme="dark"]{color-scheme:dark}*{box-sizing:border-box}html,body{max-width:100%;overflow-x:hidden}body{margin:0;padding:5px;color:var(--foreground);background:transparent;font-family:var(--font-sans);font-size:max(11px,var(--font-size-base));line-height:1.5}#widget{display:flex;flex-direction:column;gap:12px;width:100%;min-width:0;background:transparent}.card{min-width:0;padding:12px;overflow:hidden;overflow-wrap:anywhere;border-radius:var(--radius);color:var(--card-foreground);background:var(--card)}h1,h2,h3,h4,h5,h6,p{margin-block:0}h1{font-size:1.7em}h2{font-size:1.43em}h3,h4,h5,h6{font-size:1.28em}h1,h2,h3,h4,h5,h6,strong,b,th{font-weight:500}code:not(pre code){padding:1px 5px;border-radius:4px;background:var(--muted);font-family:var(--font-mono);overflow-wrap:anywhere}.viz-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(180px,100%),1fr));gap:10px}.viz-row,.viz-controls{display:flex;flex-wrap:wrap;align-items:center;gap:8px}.viz-stat{display:flex;flex-direction:column;gap:2px}.viz-stat-value{font-size:1.43em;font-weight:500}.viz-badge{padding:3px 8px;border-radius:999px;color:var(--accent-foreground);background:var(--accent);font-size:max(11px,calc(var(--font-size-base) - 2px));font-weight:500}.text-small,small{font-size:max(11px,calc(var(--font-size-base) - 2px))}.text-muted{color:var(--muted-foreground)}.text-destructive,.text-warning{color:var(--destructive)}.sr-only{position:absolute;width:1px;height:1px;padding:0;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}svg{display:block;max-width:100%;height:auto}@media(max-width:420px){body{padding:3px}.card{padding:10px}.viz-grid{grid-template-columns:1fr}}
 [data-tooltip]{position:relative}[data-tooltip]:is(:hover,:focus-visible)::after{content:attr(data-tooltip);position:absolute;z-index:50;left:50%;bottom:calc(100% + 5px);width:max-content;max-width:min(20rem,calc(100vw - 10px));padding:4px 8px;transform:translateX(-50%);border:1px solid var(--border);border-radius:var(--radius);color:var(--popover-foreground);background:var(--popover);font-size:max(11px,calc(var(--font-size-base) - 1px));font-weight:400;line-height:1.4;white-space:normal;pointer-events:none}
`;

const INLINE_VISUAL_ALLOWED_TAGS = [
  "article", "aside", "b", "blockquote", "br", "caption", "circle", "code",
  "col", "colgroup", "dd", "defs", "desc", "details", "div", "dl", "dt", "ellipse",
  "em", "figcaption", "figure", "footer", "g", "h1", "h2", "h3", "h4", "h5", "h6",
  "header", "hr", "i", "li", "line", "linearGradient", "main", "mark", "meter", "ol",
  "p", "path", "polygon", "polyline", "pre", "progress", "radialGradient", "rect", "s",
  "section", "small", "span", "stop", "strong", "summary", "svg", "table", "tbody", "td",
  "text", "tfoot", "th", "thead", "title", "tr", "tspan", "u", "ul",
] as const;

const INLINE_VISUAL_ALLOWED_ATTRIBUTES = [
  "aria-describedby", "aria-hidden", "aria-label", "aria-labelledby", "class", "colspan", "cx",
  "cy", "d", "data-tooltip", "dominant-baseline", "fill", "fill-opacity", "font-size",
  "font-weight", "fx", "fy", "gradientTransform", "gradientUnits", "height", "id", "max",
  "min", "offset", "opacity", "open", "points", "preserveAspectRatio", "r", "role", "rowspan",
  "rx", "ry", "scope", "stop-color", "stop-opacity", "stroke", "stroke-dasharray",
  "stroke-dashoffset", "stroke-linecap", "stroke-linejoin", "stroke-opacity", "stroke-width",
  "text-anchor", "title", "transform", "value", "vector-effect", "viewBox", "width", "x", "x1",
  "x2", "y", "y1", "y2",
] as const;
const INLINE_VISUAL_ALLOWED_ARIA_ATTRIBUTES = new Set([
  "aria-describedby", "aria-hidden", "aria-label", "aria-labelledby",
]);
const INLINE_VISUAL_FORBIDDEN_TAGS = [
  "a", "animate", "animateMotion", "animateTransform", "audio", "base", "button", "embed",
  "clipPath", "foreignObject", "form", "iframe", "image", "img", "input", "link", "math", "meta",
  "object", "picture", "script", "select", "source", "style", "textarea", "use", "video",
] as const;

const INLINE_VISUAL_URL_ATTRIBUTES = new Set([
  "action", "cite", "data", "formaction", "href", "poster", "src", "srcset", "xlink:href",
]);
const INLINE_VISUAL_PAINT_ATTRIBUTES = new Set(["fill", "stroke"]);
const INLINE_VISUAL_SAFE_TOKEN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const INLINE_VISUAL_SAFE_FRAGMENT_PAINT = /^url\(#[A-Za-z][A-Za-z0-9_-]{0,63}\)$/;

const INLINE_VISUAL_MAX_STYLES = 8;
const INLINE_VISUAL_MAX_CSS_BYTES = 32 * 1024;
const INLINE_VISUAL_MAX_CSS_RULES = 128;
const INLINE_VISUAL_MAX_CSS_DECLARATIONS = 512;

const INLINE_VISUAL_ALLOWED_CSS_PROPERTIES = new Set([
  "accent-color", "align-content", "align-items", "align-self", "aspect-ratio",
  "background", "background-color", "background-image", "background-position",
  "background-repeat", "background-size", "block-size", "border", "border-block",
  "border-block-color", "border-block-end", "border-block-end-color", "border-block-end-style",
  "border-block-end-width", "border-block-start", "border-block-start-color",
  "border-block-start-style", "border-block-start-width", "border-block-style",
  "border-block-width", "border-bottom", "border-bottom-color", "border-bottom-left-radius",
  "border-bottom-right-radius", "border-bottom-style", "border-bottom-width", "border-collapse",
  "border-color", "border-end-end-radius", "border-end-start-radius", "border-inline",
  "border-inline-color", "border-inline-end", "border-inline-end-color", "border-inline-end-style",
  "border-inline-end-width", "border-inline-start", "border-inline-start-color",
  "border-inline-start-style", "border-inline-start-width", "border-inline-style",
  "border-inline-width", "border-left", "border-left-color", "border-left-style",
  "border-left-width", "border-radius", "border-right", "border-right-color",
  "border-right-style", "border-right-width", "border-spacing", "border-start-end-radius",
  "border-start-start-radius", "border-style", "border-top", "border-top-color",
  "border-top-left-radius", "border-top-right-radius", "border-top-style", "border-top-width",
  "border-width", "bottom", "box-shadow", "box-sizing", "break-after", "break-before",
  "break-inside", "caption-side", "clear", "color", "color-scheme", "column-count",
  "column-gap", "column-width", "columns", "display", "empty-cells", "fill", "fill-opacity",
  "fill-rule", "flex", "flex-basis", "flex-direction", "flex-flow", "flex-grow", "flex-shrink",
  "flex-wrap", "float", "font", "font-family", "font-feature-settings", "font-kerning",
  "font-optical-sizing", "font-size", "font-stretch", "font-style", "font-variant",
  "font-variant-caps", "font-variant-ligatures", "font-weight", "gap", "grid", "grid-area",
  "grid-auto-columns", "grid-auto-flow", "grid-auto-rows", "grid-column", "grid-column-end",
  "grid-column-gap", "grid-column-start", "grid-gap", "grid-row", "grid-row-end",
  "grid-row-gap", "grid-row-start", "grid-template", "grid-template-areas",
  "grid-template-columns", "grid-template-rows", "height", "hyphens", "inline-size", "inset",
  "inset-block", "inset-block-end", "inset-block-start", "inset-inline", "inset-inline-end",
  "inset-inline-start", "isolation", "justify-content", "justify-items", "justify-self", "left",
  "letter-spacing", "line-height", "list-style-position", "list-style-type", "margin",
  "margin-block", "margin-block-end", "margin-block-start", "margin-bottom", "margin-inline",
  "margin-inline-end", "margin-inline-start", "margin-left", "margin-right", "margin-top",
  "max-block-size", "max-height", "max-inline-size", "max-width", "min-block-size", "min-height",
  "min-inline-size", "min-width", "object-fit", "object-position", "opacity", "order", "orphans",
  "outline", "outline-color", "outline-offset", "outline-style", "outline-width", "overflow",
  "overflow-wrap", "overflow-x", "overflow-y", "padding", "padding-block", "padding-block-end",
  "padding-block-start", "padding-bottom", "padding-inline", "padding-inline-end",
  "padding-inline-start", "padding-left", "padding-right", "padding-top", "place-content",
  "place-items", "place-self", "pointer-events", "position", "right", "rotate", "row-gap",
  "scale", "shape-rendering", "stroke", "stroke-dasharray", "stroke-dashoffset", "stroke-linecap",
  "stroke-linejoin", "stroke-miterlimit", "stroke-opacity", "stroke-width", "table-layout",
  "text-align", "text-align-last", "text-decoration", "text-decoration-color",
  "text-decoration-line", "text-decoration-style", "text-decoration-thickness", "text-indent",
  "text-overflow", "text-rendering", "text-shadow", "text-transform", "text-underline-offset",
  "text-wrap", "top", "transform", "transform-origin", "transform-style", "translate",
  "unicode-bidi", "vertical-align", "visibility", "white-space", "widows", "width", "word-break",
  "word-spacing", "writing-mode", "z-index",
]);

const INLINE_VISUAL_ALLOWED_CSS_FUNCTIONS = new Set([
  "calc", "clamp", "color", "color-mix", "conic-gradient", "fit-content", "hsl", "hsla", "hwb",
  "lab", "lch", "light-dark", "linear-gradient", "matrix", "matrix3d", "max", "min", "minmax",
  "oklab", "oklch", "perspective", "radial-gradient", "repeat", "repeating-conic-gradient",
  "repeating-linear-gradient", "repeating-radial-gradient", "rgb", "rgba", "rotate", "rotate3d",
  "rotateX", "rotateY", "rotateZ", "scale", "scale3d", "scaleX", "scaleY", "scaleZ", "skew",
  "skewX", "skewY", "translate", "translate3d", "translateX", "translateY", "translateZ", "var",
].map((name) => name.toLowerCase()));

const INLINE_VISUAL_THEME_CSS_VARIABLES = new Set([
  "--accent", "--accent-foreground", "--background", "--border", "--card", "--card-foreground",
  "--destructive", "--font-mono", "--font-sans", "--font-size-base", "--foreground", "--input",
  "--muted", "--muted-foreground", "--popover", "--popover-foreground", "--primary",
  "--primary-foreground", "--radius", "--ring", "--secondary", "--secondary-foreground",
  "--viz-series-1", "--viz-series-2", "--viz-series-3", "--viz-series-4", "--viz-series-5",
  "--viz-series-6",
]);

function cssValueIsSafe(value: CssNode) {
  let safe = true;
  walkCss(value, (node) => {
    if (!safe) return;
    if (node.type === "Url" || node.type === "Raw") {
      safe = false;
      return;
    }
    if (node.type === "String" && /[<>\u0000-\u001f\u007f]/.test(node.value)) {
      safe = false;
      return;
    }
    if (node.type !== "Function") return;
    const functionName = node.name.toLowerCase();
    if (!INLINE_VISUAL_ALLOWED_CSS_FUNCTIONS.has(functionName)) {
      safe = false;
      return;
    }
    if (functionName === "var") {
      const variableName = generateCss(node).match(/^var\((--[a-z0-9-]+)(?:,|\))/i)?.[1]?.toLowerCase();
      if (!variableName || !INLINE_VISUAL_THEME_CSS_VARIABLES.has(variableName)) safe = false;
    }
  });
  return safe;
}

function mediaPreludeIsSafe(prelude: CssNode | null) {
  if (!prelude) return false;
  let safe = true;
  walkCss(prelude, (node) => {
    if (node.type === "Url" || node.type === "Raw" || node.type === "Function" || node.type === "String") {
      safe = false;
    }
  });
  return safe;
}

function selectorIsSafe(selector: CssNode) {
  let safe = true;
  walkCss(selector, (node) => {
    if (node.type === "Url" || node.type === "Raw") safe = false;
    if (node.type === "String" && /[\u0000-\u001f\u007f]/.test(node.value)) safe = false;
  });
  return safe;
}

function sanitizeArtifactCss(source: string) {
  if (!source.trim() || new TextEncoder().encode(source).length > INLINE_VISUAL_MAX_CSS_BYTES) return "";
  let ast: CssNode;
  try {
    ast = parseCss(source, { context: "stylesheet", positions: false });
  } catch {
    return "";
  }
  if (ast.type !== "StyleSheet") return "";

  walkCss(ast, {
    visit: "Atrule",
    enter(node, item, list) {
      if (
        node.name.toLowerCase() !== "media"
        || !node.block
        || !mediaPreludeIsSafe(node.prelude)
      ) {
        if (item && list) list.remove(item);
      }
    },
  });

  let ruleCount = 0;
  let declarationCount = 0;
  let exceededLimits = false;
  walkCss(ast, {
    visit: "Rule",
    enter(node, item, list) {
      ruleCount += 1;
      if (ruleCount > INLINE_VISUAL_MAX_CSS_RULES) exceededLimits = true;
      if (!selectorIsSafe(node.prelude) && item && list) list.remove(item);
    },
  });
  walkCss(ast, {
    visit: "Atrule",
    enter() {
      ruleCount += 1;
      if (ruleCount > INLINE_VISUAL_MAX_CSS_RULES) exceededLimits = true;
    },
  });
  walkCss(ast, {
    visit: "Declaration",
    enter(node, item, list) {
      declarationCount += 1;
      if (declarationCount > INLINE_VISUAL_MAX_CSS_DECLARATIONS) {
        exceededLimits = true;
        return;
      }
      const property = node.property.toLowerCase();
      if (
        property.startsWith("--")
        || !INLINE_VISUAL_ALLOWED_CSS_PROPERTIES.has(property)
        || !cssValueIsSafe(node.value)
      ) {
        if (item && list) list.remove(item);
      }
    },
  });
  if (exceededLimits) return "";

  let containsRaw = false;
  walkCss(ast, (node) => {
    if (node.type === "Raw") containsRaw = true;
  });
  if (containsRaw) return "";

  const generated = generateCss(ast).replaceAll("<", "\\3c ");
  return new TextEncoder().encode(generated).length <= INLINE_VISUAL_MAX_CSS_BYTES ? generated : "";
}

function sanitizeArtifact(fragment: string) {
  const template = document.createElement("template");
  template.innerHTML = fragment;
  const styleElements = [...template.content.querySelectorAll("style")];
  let artifactCss = "";
  let styleBytes = 0;
  for (const style of styleElements) {
    const source = style.textContent ?? "";
    styleBytes += new TextEncoder().encode(source).length;
    if (styleBytes <= INLINE_VISUAL_MAX_CSS_BYTES) artifactCss += `${source}\n`;
    style.remove();
  }
  for (const element of template.content.querySelectorAll(INLINE_VISUAL_FORBIDDEN_TAGS.join(","))) {
    element.remove();
  }
  const purifier = createDOMPurify(window);
  purifier.addHook("uponSanitizeAttribute", (
    _node: Element,
    data: { attrName: string; attrValue: string; keepAttr: boolean },
  ) => {
    const name = data.attrName.toLowerCase();
    const value = (data.attrValue ?? "").trim();
    if (
      name.startsWith("on")
      || name === "style"
      || INLINE_VISUAL_URL_ATTRIBUTES.has(name)
      || /[\u0000-\u001f\u007f]/.test(value)
    ) {
      data.keepAttr = false;
      return;
    }
    if (name.startsWith("aria-") && !INLINE_VISUAL_ALLOWED_ARIA_ATTRIBUTES.has(name)) {
      data.keepAttr = false;
      return;
    }
    if (name === "id" && !INLINE_VISUAL_SAFE_TOKEN.test(value)) {
      data.keepAttr = false;
      return;
    }
    if (name === "class") {
      const safeClasses = value.split(/\s+/).filter((token) => INLINE_VISUAL_SAFE_TOKEN.test(token)).slice(0, 24);
      if (safeClasses.length === 0) data.keepAttr = false;
      else data.attrValue = safeClasses.join(" ");
      return;
    }
    if (name === "data-tooltip") {
      if (!value || value.length > 240) data.keepAttr = false;
      else data.attrValue = value;
      return;
    }
    if (INLINE_VISUAL_PAINT_ATTRIBUTES.has(name) && /url\s*\(/i.test(value)) {
      if (!INLINE_VISUAL_SAFE_FRAGMENT_PAINT.test(value)) data.keepAttr = false;
    }
  });
  const safeFragment = purifier.sanitize(template.innerHTML, {
    ALLOWED_TAGS: [...INLINE_VISUAL_ALLOWED_TAGS],
    ALLOWED_ATTR: [...INLINE_VISUAL_ALLOWED_ATTRIBUTES],
    ALLOW_ARIA_ATTR: true,
    ALLOW_DATA_ATTR: false,
    FORBID_TAGS: [...INLINE_VISUAL_FORBIDDEN_TAGS],
    SAFE_FOR_TEMPLATES: true,
    RETURN_TRUSTED_TYPE: false,
  });
  const safeCss = styleElements.length <= INLINE_VISUAL_MAX_STYLES && styleBytes <= INLINE_VISUAL_MAX_CSS_BYTES
    ? sanitizeArtifactCss(artifactCss)
    : "";
  return { safeCss, safeFragment };
}

export function buildInlineVisualSrcDoc(fragment: string, theme: "light" | "dark") {
  const { safeCss, safeFragment } = sanitizeArtifact(fragment);
  const artifactStyle = safeCss ? `<style>${safeCss}</style>` : "";
  return `<!doctype html><html data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${INLINE_VISUAL_CSP}"><style>${VISUAL_RUNTIME_CSS}</style>${artifactStyle}</head><body>${safeFragment}</body></html>`;
}

export function clampInlineVisualHeight(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(1200, Math.max(120, Math.round(value)));
}

function ownedVisualAttachment(message: ChatMessage, attachmentId: string, file: string) {
  return message.attachments.find((attachment) =>
    attachment.id === attachmentId
    && attachment.messageId === message.id
    && attachment.contentType.toLowerCase() === "text/html"
    && attachment.originalFilename === file
    && Boolean(attachment.createdByAgentId)
    && !attachment.createdByUserId
    && attachment.byteSize > 0
    && attachment.byteSize <= 2 * 1024 * 1024
  ) ?? null;
}

function ownedRudderVisualAttachment(
  message: ChatMessage,
  mapping: Extract<ReturnType<typeof rudderInlineVisualMappingsFromStructuredPayload>[number], { status: "ready" }>,
) {
  return message.attachments.find((attachment) =>
    attachment.id === mapping.attachmentId
    && attachment.messageId === message.id
    && attachment.contentType === mapping.contentType
    && attachment.originalFilename === mapping.file
    && attachment.byteSize === mapping.byteSize
    && attachment.sha256.toLowerCase() === mapping.sha256
    && Boolean(attachment.createdByAgentId)
    && !attachment.createdByUserId
    && attachment.byteSize > 0
    && attachment.byteSize <= MAX_RUDDER_INLINE_VISUAL_FRAGMENT_BYTES
  ) ?? null;
}

function InlineVisualFallback() {
  return (
    <div className="my-2 flex min-h-16 items-center gap-3 rounded-md border border-border/70 bg-muted/25 px-3 py-2 text-sm">
      <AlertTriangle className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 flex-1 text-foreground">Visual artifact unavailable</span>
    </div>
  );
}

function InlineVisualFrame({ attachment, theme }: { attachment: ChatAttachment; theme: "light" | "dark" }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const measurementFrameRef = useRef<number | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const [srcDoc, setSrcDoc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [height, setHeight] = useState(120);

  useEffect(() => {
    const controller = new AbortController();
    setSrcDoc(null);
    setFailed(false);
    if (measurementFrameRef.current !== null) cancelAnimationFrame(measurementFrameRef.current);
    measurementFrameRef.current = null;
    resizeObserverRef.current?.disconnect();
    resizeObserverRef.current = null;
    void fetch(attachment.contentPath, { credentials: "same-origin", signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("visual source unavailable");
        return response.text();
      })
      .then((fragment) => {
        if (new TextEncoder().encode(fragment).length > 2 * 1024 * 1024) throw new Error("visual source too large");
        setSrcDoc(buildInlineVisualSrcDoc(fragment, theme));
      })
      .catch((error) => {
        if ((error as Error).name !== "AbortError") setFailed(true);
      });
    return () => {
      controller.abort();
      if (measurementFrameRef.current !== null) cancelAnimationFrame(measurementFrameRef.current);
      measurementFrameRef.current = null;
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
    };
  }, [attachment.contentPath, theme]);

  const measureFrame = () => {
    const frameDocument = iframeRef.current?.contentDocument;
    if (!frameDocument) return;
    const body = frameDocument.body;
    const widget = frameDocument.getElementById("widget");
    const bodyStyle = body ? frameDocument.defaultView?.getComputedStyle(body) : null;
    const bodyPadding = bodyStyle
      ? (Number.parseFloat(bodyStyle.paddingTop) || 0) + (Number.parseFloat(bodyStyle.paddingBottom) || 0)
      : 0;
    const widgetHeight = widget?.getBoundingClientRect().height ?? 0;
    const contentHeight = widgetHeight > 0
      ? widgetHeight + bodyPadding
      : Math.max(
        frameDocument.documentElement?.scrollHeight ?? 0,
        body?.scrollHeight ?? 0,
      );
    const nextHeight = clampInlineVisualHeight(contentHeight);
    if (nextHeight !== null) setHeight(nextHeight);
  };

  const scheduleFrameMeasurement = () => {
    if (measurementFrameRef.current !== null) cancelAnimationFrame(measurementFrameRef.current);
    measurementFrameRef.current = requestAnimationFrame(() => {
      measurementFrameRef.current = null;
      measureFrame();
    });
  };

  const handleFrameLoad = () => {
    resizeObserverRef.current?.disconnect();
    resizeObserverRef.current = null;
    scheduleFrameMeasurement();
    const frameDocument = iframeRef.current?.contentDocument;
    if (!frameDocument || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(scheduleFrameMeasurement);
    if (frameDocument.documentElement) observer.observe(frameDocument.documentElement);
    if (frameDocument.body) observer.observe(frameDocument.body);
    const widget = frameDocument.getElementById("widget");
    if (widget) observer.observe(widget);
    resizeObserverRef.current = observer;
  };

  if (failed) return <InlineVisualFallback />;
  if (!srcDoc) return <div className="my-2 h-32 animate-pulse rounded-md bg-muted/25" aria-label="Loading visual artifact" />;
  return (
    <iframe
      ref={iframeRef}
      {...{ [CHAT_ANNOTATION_IGNORE_ATTRIBUTE]: "" }}
      className="my-2 block w-full border-0 bg-transparent"
      title={attachment.originalFilename ?? "Visual artifact"}
      sandbox="allow-same-origin"
      {...({ csp: INLINE_VISUAL_CSP, credentialless: "" } as Record<string, string>)}
      referrerPolicy="no-referrer"
      srcDoc={srcDoc}
      style={{ height }}
      onError={() => setFailed(true)}
      onLoad={handleFrameLoad}
    />
  );
}

type MarkdownProps = Omit<ComponentProps<typeof MarkdownBody>, "children">;

export function ChatInlineVisualContent({ message, markdownProps }: {
  message: ChatMessage;
  markdownProps?: MarkdownProps;
}) {
  const { resolvedTheme } = useTheme();
  const renderModel = useMemo(() => {
    if (message.role !== "assistant" || message.kind !== "message") return null;
    const legacy = parseCodexInlineVisualDirectives(message.body).directives.map((directive) => ({
      kind: "legacy" as const,
      key: `legacy-${directive.index}`,
      index: directive.index,
      file: directive.file,
      start: directive.start,
      end: directive.end,
    }));
    const canonical = parseRudderInlineVisualPlacements(message.body).placements.map((placement) => ({
      kind: "rudder" as const,
      key: `rudder-${placement.slot}`,
      slot: placement.slot,
      start: placement.start,
      end: placement.end,
    }));
    const directives = [...legacy, ...canonical].sort((a, b) => a.start - b.start);
    if (directives.length === 0) return null;
    return {
      directives,
      legacyMappings: chatInlineVisualMappingsFromStructuredPayload(message.structuredPayload),
      rudderMappings: rudderInlineVisualMappingsFromStructuredPayload(message.structuredPayload),
      completed: message.status === "completed",
    };
  }, [message]);

  if (!renderModel) return <MarkdownBody {...markdownProps}>{message.body}</MarkdownBody>;

  const pieces: Array<{ kind: "markdown"; body: string } | { kind: "visual"; directiveKey: string }> = [];
  let cursor = 0;
  for (const directive of renderModel.directives) {
    if (directive.start > cursor) pieces.push({ kind: "markdown", body: message.body.slice(cursor, directive.start) });
    pieces.push({ kind: "visual", directiveKey: directive.key });
    cursor = directive.end;
  }
  if (cursor < message.body.length) pieces.push({ kind: "markdown", body: message.body.slice(cursor) });

  return (
    <div className="min-w-0">
      {pieces.map((piece, pieceIndex) => {
        if (piece.kind === "markdown") {
          return piece.body.trim() ? <MarkdownBody key={`markdown-${pieceIndex}`} {...markdownProps}>{piece.body}</MarkdownBody> : null;
        }
        const directive = renderModel.directives.find((entry) => entry.key === piece.directiveKey)!;
        if (!renderModel.completed) {
          return message.status === "failed" || message.status === "stopped"
            ? <InlineVisualFallback key={`visual-${directive.key}`} />
            : null;
        }
        const attachment = directive.kind === "legacy"
          ? (() => {
            const mapping = renderModel.legacyMappings.find((entry) =>
              entry.directiveIndex === directive.index && entry.file === directive.file
            );
            return mapping?.status === "ready"
              ? ownedVisualAttachment(message, mapping.attachmentId, mapping.file)
              : null;
          })()
          : (() => {
            const mapping = renderModel.rudderMappings.find((entry) => entry.slot === directive.slot);
            return mapping?.status === "ready" ? ownedRudderVisualAttachment(message, mapping) : null;
          })();
        return attachment
          ? <InlineVisualFrame key={`visual-${directive.key}`} attachment={attachment} theme={resolvedTheme} />
          : <InlineVisualFallback key={`visual-${directive.key}`} />;
      })}
    </div>
  );
}
