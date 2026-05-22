import { readDesktopShell, type DesktopImageDataPayload } from "@/lib/desktop-shell";

export function isImageContentType(contentType: string | null | undefined) {
  return Boolean(contentType?.toLowerCase().startsWith("image/"));
}

function extensionForImageContentType(contentType: string) {
  switch (contentType.toLowerCase().split(";")[0]) {
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "image/svg+xml":
      return ".svg";
    case "image/png":
    default:
      return ".png";
  }
}

export function resolveImageFilename(name: string, contentType: string, fallback = "image") {
  const trimmed = name.trim() || fallback;
  return /\.[a-z0-9]{2,8}$/i.test(trimmed) ? trimmed : `${trimmed}${extensionForImageContentType(contentType)}`;
}

async function blobToBase64(blob: Blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

export async function createImageDesktopPayload(
  blob: Blob,
  name: string,
  fallback = "image",
): Promise<DesktopImageDataPayload> {
  const contentType = blob.type || "image/png";
  return {
    filename: resolveImageFilename(name, contentType, fallback),
    contentType,
    base64: await blobToBase64(blob),
  };
}

export async function fetchImageBlob(src: string) {
  const response = await fetch(src, { credentials: "include" });
  if (!response.ok) {
    throw new Error(`Unable to load image (${response.status}).`);
  }

  const blob = await response.blob();
  if (!isImageContentType(blob.type)) {
    throw new Error("The selected asset is not an image.");
  }
  return blob;
}

async function copyImageBlobWithBrowserClipboard(blob: Blob) {
  const ClipboardItemCtor = typeof ClipboardItem === "undefined" ? null : ClipboardItem;
  if (!navigator.clipboard?.write || !ClipboardItemCtor) {
    throw new Error("Copy Image is only available in the desktop app or a clipboard-enabled browser.");
  }
  await navigator.clipboard.write([
    new ClipboardItemCtor({
      [blob.type || "image/png"]: blob,
    }),
  ]);
}

export async function copyImage(src: string, name: string) {
  const blob = await fetchImageBlob(src);
  const desktopShell = readDesktopShell();
  if (desktopShell?.copyImage) {
    await desktopShell.copyImage(await createImageDesktopPayload(blob, name));
    return;
  }
  await copyImageBlobWithBrowserClipboard(blob);
}

export async function showImageInFolder(src: string, name: string) {
  const desktopShell = readDesktopShell();
  if (!desktopShell?.showImageInFolder) {
    throw new Error("Open in Finder is available in the desktop app.");
  }
  const blob = await fetchImageBlob(src);
  await desktopShell.showImageInFolder(await createImageDesktopPayload(blob, name));
}

export function canShowImageInFolder() {
  return Boolean(readDesktopShell()?.showImageInFolder);
}

export function openImage(src: string) {
  window.open(src, "_blank", "noopener,noreferrer");
}

export async function downloadImage(src: string, name: string) {
  const blob = await fetchImageBlob(src);
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = resolveImageFilename(name, blob.type || "image/png");
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
}
