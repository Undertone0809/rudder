const WORKSPACE_HTML_FILE_EXTENSIONS = new Set([".html", ".htm"]);
const WORKSPACE_HTML_STATIC_FALLBACK_CSP =
  "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; script-src 'none'; connect-src 'none'";

function workspaceFileExtension(filePath: string | null | undefined) {
  if (!filePath) return null;
  const basename = filePath.split("/").at(-1) ?? filePath;
  const extensionIndex = basename.lastIndexOf(".");
  return extensionIndex === -1 ? null : basename.slice(extensionIndex).toLowerCase();
}

export function isWorkspaceHtmlFilePath(filePath: string | null | undefined) {
  const extension = workspaceFileExtension(filePath);
  return extension !== null && WORKSPACE_HTML_FILE_EXTENSIONS.has(extension);
}

export function isWorkspaceHtmlContentType(contentType: string | null | undefined) {
  return typeof contentType === "string"
    && contentType.toLowerCase().split(";")[0]?.trim() === "text/html";
}

function isExternalNavigationTarget(value: string) {
  const normalized = value
    .replace(/[\t\n\r]/g, "")
    .replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, "");
  return normalized.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(normalized);
}

export function buildWorkspaceHtmlStaticFallbackSrcDoc(content: string) {
  const document = new DOMParser().parseFromString(content, "text/html");
  document.querySelectorAll("meta[http-equiv]").forEach((element) => {
    if (element.getAttribute("http-equiv")?.trim().toLowerCase() === "refresh") {
      element.remove();
    }
  });
  document.querySelectorAll("base").forEach((element) => element.remove());
  document.querySelectorAll<HTMLElement>("a[href],area[href]").forEach((element) => {
    const href = element.getAttribute("href");
    if (element.hasAttribute("download")) {
      element.removeAttribute("download");
      element.removeAttribute("href");
      element.setAttribute("data-rudder-blocked-href", "download");
    } else if (href && isExternalNavigationTarget(href)) {
      element.removeAttribute("href");
      element.setAttribute("data-rudder-blocked-href", "external");
    }
    element.removeAttribute("ping");
  });

  const policy = document.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  policy.content = WORKSPACE_HTML_STATIC_FALLBACK_CSP;
  document.head.prepend(policy);
  return `<!doctype html>${document.documentElement.outerHTML}`;
}
