import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverLocalAppIcon } from "./local-app-icon-discovery.js";

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

async function fixture() {
  return mkdtemp(path.join(tmpdir(), "rudder-local-app-icon-"));
}

describe("Local App icon discovery", () => {
  it.each([
    ["Next.js App Router", "src/app/favicon.ico", Buffer.from([0, 0, 1, 0, 1, 0])],
    ["React public favicon", "public/favicon.png", PNG],
    ["Vue/Vite SVG favicon", "public/favicon.svg", Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M0 0h1v1z\"/></svg>")],
  ])("recognizes %s conventions", async (_label, relative, bytes) => {
    const root = await fixture();
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), bytes);

    await expect(discoverLocalAppIcon(root)).resolves.toMatch(/^data:image\//);
  });

  it("prefers explicit HTML and manifest icons over framework fallbacks", async () => {
    const root = await fixture();
    await mkdir(path.join(root, "public", "icons"), { recursive: true });
    await writeFile(path.join(root, "index.html"), '<link rel="manifest" href="/manifest.json">');
    await writeFile(path.join(root, "public", "manifest.json"), JSON.stringify({
      icons: [{ src: "icons/app.png", sizes: "32x32" }],
    }));
    await writeFile(path.join(root, "public", "icons", "app.png"), PNG);
    await writeFile(path.join(root, "public", "favicon.svg"), "<svg><script>alert(1)</script></svg>");

    await expect(discoverLocalAppIcon(root)).resolves.toBe(`data:image/png;base64,${PNG.toString("base64")}`);
  });

  it("resolves Vite-style root icon URLs from the public directory", async () => {
    const root = await fixture();
    await mkdir(path.join(root, "public"), { recursive: true });
    await writeFile(path.join(root, "index.html"), '<link rel="icon" href="/vite.svg">');
    await writeFile(
      path.join(root, "public", "vite.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"/></svg>',
    );

    await expect(discoverLocalAppIcon(root)).resolves.toMatch(
      /^data:image\/svg\+xml;base64,/,
    );
  });

  it("uses a framework badge only when the project has no own icon", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      scripts: { dev: "vite" },
      devDependencies: { vite: "^6.0.0" },
    }));

    await expect(discoverLocalAppIcon(root)).resolves.toMatch(
      /^data:image\/svg\+xml;base64,/,
    );

    await mkdir(path.join(root, "src", "assets"), { recursive: true });
    await writeFile(path.join(root, "src", "assets", "logo.png"), PNG);
    await expect(discoverLocalAppIcon(root)).resolves.toBe(
      `data:image/png;base64,${PNG.toString("base64")}`,
    );
  });

  it("uses the app framework badge instead of the underlying Vite badge", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      scripts: { dev: "vite" },
      dependencies: { react: "^19.0.0" },
      devDependencies: { vite: "^6.0.0" },
    }));

    const icon = await discoverLocalAppIcon(root);
    expect(icon).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(Buffer.from(icon!.split(",", 2)[1], "base64").toString("utf8"))
      .toContain(">R</text>");
  });

  it("rejects external, traversing, symlink-escaped, unsafe SVG, and oversized candidates", async () => {
    const root = await fixture();
    const outside = await fixture();
    await writeFile(path.join(outside, "secret.png"), PNG);
    await mkdir(path.join(root, "public"), { recursive: true });
    await symlink(path.join(outside, "secret.png"), path.join(root, "public", "escaped.png"));
    await writeFile(path.join(root, "index.html"), [
      '<link rel="icon" href="https://example.com/icon.png">',
      '<link rel="icon" href="../secret.png">',
      '<link rel="icon" href="/escaped.png">',
      '<link rel="icon" href="/unsafe.svg">',
      '<link rel="icon" href="/huge.png">',
    ].join("\n"));
    await writeFile(path.join(root, "public", "unsafe.svg"), '<svg onload="alert(1)"><script/></svg>');
    await writeFile(path.join(root, "public", "huge.png"), Buffer.alloc(400 * 1024, 1));

    await expect(discoverLocalAppIcon(root)).resolves.toBeNull();
  });
});
