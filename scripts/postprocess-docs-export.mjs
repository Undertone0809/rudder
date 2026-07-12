#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const CANONICAL_ORIGIN = "https://docs.rudderhq.dev";
const MARKDOWN_ALTERNATE_RE =
  /<link\b(?=[^>]*\brel=["']alternate["'])(?=[^>]*\btype=["']text\/markdown["'])[^>]*\/?\s*>/gi;
const HREFLANG_ALTERNATE_RE =
  /<link\b(?=[^>]*\brel=["']alternate["'])(?=[^>]*\bhreflang=["'][^"']+["'])[^>]*\/?\s*>/gi;
const SEO_GUARD_RE = /<script\b[^>]*\bdata-rudder-seo-guard[^>]*>[\s\S]*?<\/script>/gi;
const CHINESE_FOOTER_PATHS = [
  "/get-started/installation",
  "/get-started/first-organization",
  "/how-to/issue-lifecycle",
  "/how-to/configure-agent-runtime",
  "/concepts/chat-messenger",
  "/concepts/calendar",
  "/releases",
];

function collectPageFiles(exportDir) {
  const files = [];

  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(filePath);
      } else if (entry.name === "index.html") {
        files.push(filePath);
      }
    }
  }

  visit(exportDir);
  return files.sort();
}

function routeForFile(exportDir, filePath) {
  const relativePath = path.relative(exportDir, filePath).split(path.sep).join("/");
  if (relativePath === "index.html") return "/";
  return `/${relativePath.slice(0, -"/index.html".length)}`;
}

function canonicalUrl(route) {
  return route === "/" ? CANONICAL_ORIGIN : `${CANONICAL_ORIGIN}${route}`;
}

function replaceHtmlLang(html, language) {
  return html.replace(
    /<html\b([^>]*?)\blang=(["'])[^"']*\2/i,
    (_match, before) => `<html${before}lang="${language}"`,
  );
}

function languageRoutes(route, routes) {
  const isChinese = route === "/zh" || route.startsWith("/zh/");
  const englishRoute = isChinese ? (route === "/zh" ? "/" : route.slice(3)) : route;
  const chineseRoute = isChinese ? route : route === "/" ? "/zh" : `/zh${route}`;

  if (!routes.has(englishRoute) || !routes.has(chineseRoute)) return null;
  return { chineseRoute, englishRoute };
}

function injectLanguageAlternates(html, pair) {
  const tags = [
    `<link rel="alternate" hreflang="en" href="${canonicalUrl(pair.englishRoute)}"/>`,
    `<link rel="alternate" hreflang="zh-CN" href="${canonicalUrl(pair.chineseRoute)}"/>`,
    `<link rel="alternate" hreflang="x-default" href="${canonicalUrl(pair.englishRoute)}"/>`,
  ].join("");

  if (!html.includes("</head>")) {
    throw new Error("Exported docs page is missing </head>");
  }
  return html.replace("</head>", `${tags}</head>`);
}

function injectSeoGuard(html, isChinese) {
  const languageGuard = isChinese
    ? 'if(document.documentElement.lang!=="zh-CN")document.documentElement.lang="zh-CN";'
    : "";
  const script = `<script data-rudder-seo-guard>(function(){const fix=function(){${languageGuard}document.querySelectorAll('link[rel="alternate"][type="text/markdown"]').forEach(function(link){link.remove()})};fix();new MutationObserver(fix).observe(document.documentElement,{attributes:true,attributeFilter:["lang"],childList:true,subtree:true})})()</script>`;

  if (!html.includes("</head>")) {
    throw new Error("Exported docs page is missing </head>");
  }
  return html.replace("</head>", `${script}</head>`);
}

function localizeFooterMarkup(html) {
  const footerStart = html.indexOf('<footer id="footer"');
  if (footerStart === -1) return html;
  const footerEnd = html.indexOf("</footer>", footerStart);
  if (footerEnd === -1) throw new Error("Exported docs page has an unclosed footer");

  const before = html.slice(0, footerStart);
  let footer = html.slice(footerStart, footerEnd + "</footer>".length);
  const after = html.slice(footerEnd + "</footer>".length);

  for (const englishPath of CHINESE_FOOTER_PATHS) {
    footer = footer.replaceAll(`href="${englishPath}"`, `href="/zh${englishPath}"`);
  }
  return before + footer + after;
}

function localizeSerializedFooter(html) {
  const startMarker = '\\"footer\\":';
  const endMarker = ',\\"seo\\":';
  let searchFrom = 0;

  while (true) {
    const start = html.indexOf(startMarker, searchFrom);
    if (start === -1) return html;
    const configuredEnd = html.indexOf(endMarker, start);
    const scriptEnd = html.indexOf("</script>", start);
    const end = configuredEnd === -1 ? scriptEnd : configuredEnd;
    if (end === -1) throw new Error("Could not isolate serialized docs footer config");

    let footer = html.slice(start, end);
    for (const englishPath of CHINESE_FOOTER_PATHS) {
      footer = footer.replaceAll(
        `\\"href\\":\\"${englishPath}\\"`,
        `\\"href\\":\\"/zh${englishPath}\\"`,
      );
    }
    html = html.slice(0, start) + footer + html.slice(end);
    searchFrom = start + footer.length;
  }
}

function postprocessExport(exportDir) {
  const pageFiles = collectPageFiles(exportDir);
  if (pageFiles.length === 0) throw new Error(`No exported docs pages found in ${exportDir}`);

  const pageRoutes = new Map(pageFiles.map((filePath) => [routeForFile(exportDir, filePath), filePath]));
  const routes = new Set(pageRoutes.keys());
  let pairedPages = 0;
  let chinesePages = 0;

  for (const [route, filePath] of pageRoutes) {
    const isChinese = route === "/zh" || route.startsWith("/zh/");
    let html = fs.readFileSync(filePath, "utf8");
    html = html
      .replace(MARKDOWN_ALTERNATE_RE, "")
      .replace(HREFLANG_ALTERNATE_RE, "")
      .replace(SEO_GUARD_RE, "");
    html = replaceHtmlLang(html, isChinese ? "zh-CN" : "en");

    const pair = languageRoutes(route, routes);
    if (pair) {
      html = injectLanguageAlternates(html, pair);
      pairedPages += 1;
    }

    html = injectSeoGuard(html, isChinese);

    if (isChinese) {
      html = localizeSerializedFooter(localizeFooterMarkup(html));
      chinesePages += 1;
    }

    fs.writeFileSync(filePath, html);
  }

  console.log(
    `Postprocessed ${pageFiles.length} docs pages (${chinesePages} Chinese, ${pairedPages} with language alternates).`,
  );
}

const exportDir = process.argv[2];
if (!exportDir) {
  console.error("Usage: node scripts/postprocess-docs-export.mjs <export-directory>");
  process.exit(1);
}

postprocessExport(path.resolve(exportDir));
