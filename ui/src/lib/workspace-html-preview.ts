const WORKSPACE_HTML_FILE_EXTENSIONS = new Set([".html", ".htm"]);

const WORKSPACE_HTML_PREVIEW_CSP_META =
  "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'; frame-src 'none'\">";

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

export function buildWorkspaceHtmlPreviewSrcDoc(content: string) {
  // Keep the policy in a trusted prefix. Searching the untrusted document for
  // its first <head> can place the policy inside a comment or script string.
  return `<!doctype html><html><head>${WORKSPACE_HTML_PREVIEW_CSP_META}</head><body>${content}</body></html>`;
}
