import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  OFFICIAL_RUDDER_LOGO_SHA256,
  resolveOfficialRudderLogoDataUrl,
} from "./brand-logo.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("official Rudder logo", () => {
  it("loads the exact packaged official asset and rejects a modified copy", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-logo-test-"));
    temporaryRoots.push(root);
    const official = fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../ui/public/rudder-logo.png"),
    );
    fs.writeFileSync(path.join(root, "rudder-logo.png"), official);

    const dataUrl = resolveOfficialRudderLogoDataUrl({
      isPackaged: true,
      moduleDir: "/unused",
      resourcesPath: root,
    });
    expect(dataUrl).toBe(`data:image/png;base64,${official.toString("base64")}`);
    expect(OFFICIAL_RUDDER_LOGO_SHA256).toBe(
      "9f44fb2408a53587acf1f7ad769abb8671d74a81475dae68f4a2056dce4e13fe",
    );

    fs.writeFileSync(path.join(root, "rudder-logo.png"), Buffer.concat([official, Buffer.from("modified")]));
    expect(resolveOfficialRudderLogoDataUrl({
      isPackaged: true,
      moduleDir: "/unused",
      resourcesPath: root,
    })).toBeNull();
  });

  it("ships the official asset as a packaged Desktop resource", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../package.json"),
        "utf8",
      ),
    ) as {
      build?: { extraResources?: Array<{ from?: string; to?: string }> };
    };
    expect(packageJson.build?.extraResources).toContainEqual({
      from: "../ui/public/rudder-logo.png",
      to: "rudder-logo.png",
    });
  });
});
