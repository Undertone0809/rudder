import { describe, expect, it } from "vitest";
import { createRendererRecoveryScreenHtml } from "./boot-screen.js";

describe("renderer recovery screen", () => {
  it("renders recovery actions and escapes diagnostic text", () => {
    const html = createRendererRecoveryScreenHtml("Rudder", {
      title: "Renderer exited",
      message: "Rudder's UI process exited unexpectedly.",
      detail: "<script>alert('x')</script>",
    });

    expect(html).toContain("Reload UI");
    expect(html).toContain("Restart Rudder");
    expect(html).toContain("Copy diagnostic");
    expect(html).toContain("window.desktopShell.reloadApp()");
    expect(html).toContain("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert('x')</script>");
  });
});
