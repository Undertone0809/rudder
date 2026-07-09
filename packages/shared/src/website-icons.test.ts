import { describe, expect, it } from "vitest";
import { KNOWN_WEBSITE_ICONS, resolveKnownWebsiteIcon } from "./website-icons.js";

describe("resolveKnownWebsiteIcon", () => {
  function expectImageSignature(icon: (typeof KNOWN_WEBSITE_ICONS)[number], bytes: Buffer) {
    if (icon.iconDataUrl.startsWith("data:image/png;base64,")) {
      expect(bytes.subarray(0, 8), `${icon.siteName} icon should be a PNG`).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
      return;
    }

    if (icon.iconDataUrl.startsWith("data:image/x-icon;base64,")) {
      expect(bytes.subarray(0, 4), `${icon.siteName} icon should be an ICO`).toEqual(
        Buffer.from([0x00, 0x00, 0x01, 0x00]),
      );
      return;
    }

    if (icon.iconDataUrl.startsWith("data:image/svg+xml;base64,")) {
      expect(bytes.subarray(0, 128).toString("utf8"), `${icon.siteName} icon should be an SVG`).toContain("<svg");
      return;
    }

    throw new Error(`${icon.siteName} has an unsupported icon MIME type`);
  }

  it("resolves known public sites used in rendered link icons", () => {
    expect(resolveKnownWebsiteIcon("https://x.com/user/status/1")?.siteName).toBe("X");
    expect(resolveKnownWebsiteIcon("https://www.linkedin.com/pulse/post")?.siteName).toBe("LinkedIn");
    expect(resolveKnownWebsiteIcon("https://platform.openai.com/docs")?.siteName).toBe("OpenAI");
    expect(resolveKnownWebsiteIcon("https://chatgpt.com/c/example")?.siteName).toBe("ChatGPT");
    expect(resolveKnownWebsiteIcon("https://claude.ai/chat/example")?.siteName).toBe("Claude");
    expect(resolveKnownWebsiteIcon("https://www.figma.com/design/file")?.siteName).toBe("Figma");
    expect(resolveKnownWebsiteIcon("https://docs.feishu.cn/docx/example")?.siteName).toBe("Feishu");
    expect(resolveKnownWebsiteIcon("https://rudderhq.dev/docs")?.siteName).toBe("Rudder");
    expect(resolveKnownWebsiteIcon("https://app.rudder.zeeland.studio/issues/RUD-1")?.siteName).toBe("Rudder");
  });

  it("does not treat unrelated provider subdomains as known site icons", () => {
    expect(resolveKnownWebsiteIcon("https://developers.google.com/engineering-practices/code-review")).toBeNull();
  });

  it("uses real embedded image assets instead of generated letter placeholders", () => {
    for (const icon of KNOWN_WEBSITE_ICONS) {
      expect(icon.iconDataUrl).toMatch(/^data:image\/(?:x-icon|png|svg\+xml);base64,/u);
      expect(icon.iconDataUrl).not.toMatch(/^data:image\/svg\+xml,/u);

      const [, base64 = ""] = icon.iconDataUrl.split(",", 2);
      const bytes = Buffer.from(base64, "base64");
      expect(bytes.byteLength, `${icon.siteName} icon should not be empty`).toBeGreaterThan(100);

      const prefix = bytes.subarray(0, 32).toString("utf8").toLowerCase();
      expect(prefix, `${icon.siteName} icon must not be an HTML response`).not.toContain("<!doctype");
      expect(prefix, `${icon.siteName} icon must not be an HTML response`).not.toContain("<html");
      expectImageSignature(icon, bytes);
    }
  });

  it("uses the default Rudder favicon.ico for Rudder-owned domains", async () => {
    const icon = resolveKnownWebsiteIcon("https://rudderhq.dev/docs");
    expect(icon?.siteName).toBe("Rudder");
    expect(icon?.iconDataUrl).toMatch(/^data:image\/x-icon;base64,/u);

    const [, base64 = ""] = icon?.iconDataUrl.split(",", 2) ?? [];
    const bytes = Buffer.from(base64, "base64");
    const favicon = await import("node:fs/promises").then((fs) => fs.readFile("ui/public/favicon.ico"));
    expect(bytes).toEqual(favicon);
  });
});
