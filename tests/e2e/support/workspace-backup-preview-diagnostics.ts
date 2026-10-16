import type { Page, Response, TestInfo } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

type PreviewResponse = {
  url: string;
  status: number;
  bodyState: "pending" | "received" | "failed";
  body?: string;
  bodyError?: string;
};

function withDeadline<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

export async function withWorkspaceBackupPreviewDiagnostics(
  page: Page,
  testInfo: TestInfo,
  organizationId: string,
  filePath: string,
  action: () => Promise<void>,
): Promise<void> {
  const responses: PreviewResponse[] = [];
  const pendingBodies: Promise<void>[] = [];
  const pageErrors: string[] = [];
  const onPageError = (error: Error) => pageErrors.push(error.message);
  const onResponse = (response: Response) => {
    const url = new URL(response.url());
    if (response.request().method() !== "GET"
      || !url.pathname.startsWith(`/api/orgs/${organizationId}/workspace/backups/`)
      || !url.pathname.endsWith("/file")
      || url.searchParams.get("path") !== filePath) return;
    const observed: PreviewResponse = { url: response.url(), status: response.status(), bodyState: "pending" };
    responses.push(observed);
    pendingBodies.push(response.text().then((body) => {
      observed.body = body;
      observed.bodyState = "received";
    }, (error: unknown) => {
      observed.bodyError = String(error);
      observed.bodyState = "failed";
    }));
  };
  page.on("response", onResponse);
  page.on("pageerror", onPageError);
  try {
    // Observe concurrently: the original click/assertion timing stays intact.
    await action();
  } catch (error) {
    let collectionFinished = false;
    try {
      await withDeadline((async () => {
        // Start visual/state capture immediately, before waiting on body evidence.
        const domCapture = withDeadline(page.evaluate(() => {
          const currentUrl = new URL(window.location.href);
          const card = document.querySelector<HTMLElement>('[data-testid="workspace-main-card"]');
          return {
            url: currentUrl.href,
            selectedBackup: currentUrl.searchParams.get("backup"),
            selectedFile: currentUrl.searchParams.get("file"),
            mainCardText: card?.innerText ?? null,
            mainCardHtml: card?.outerHTML ?? null,
          };
        }), 1_000, "DOM capture").catch((captureError: unknown) => ({ captureError: String(captureError) }));
        const screenshotPath = testInfo.outputPath("test-failed-backup-preview.png");
        const screenshotCapture = page.screenshot({ path: screenshotPath, fullPage: true, timeout: 2_000 })
          .then(() => null, (captureError: unknown) => String(captureError));
        let bodyDeadline: ReturnType<typeof setTimeout> | undefined;
        try {
          // This bound only limits evidence collection after the assertion failed.
          await Promise.race([
            Promise.all(pendingBodies),
            new Promise<void>((resolve) => { bodyDeadline = setTimeout(resolve, 1_000); }),
          ]);
        } finally {
          clearTimeout(bodyDeadline);
        }
        const [dom, screenshotError] = await Promise.all([domCapture, screenshotCapture]);
        if (collectionFinished) return;
        const diagnostics = { organizationId, filePath, url: page.url(), responses, pageErrors, dom, screenshotError };
        console.log("Workspace backup preview diagnostics", JSON.stringify(diagnostics));
        // Reuse the CI artifact step's existing **/error-context.md and
        // **/test-failed-*.png patterns without changing qualification behavior.
        const contextPath = testInfo.outputPath("backup-preview-diagnostics", "error-context.md");
        await fs.mkdir(path.dirname(contextPath), { recursive: true });
        if (collectionFinished) return;
        await fs.writeFile(contextPath, `# Workspace backup preview diagnostics\n\n\`\`\`json\n${JSON.stringify(diagnostics, null, 2)}\n\`\`\`\n`);
        if (collectionFinished) return;
        await testInfo.attach("workspace-backup-preview-context", { path: contextPath, contentType: "text/markdown" });
        if (collectionFinished) return;
        if (!screenshotError) {
          await testInfo.attach("workspace-backup-preview-screenshot", { path: screenshotPath, contentType: "image/png" });
        }
      })(), 3_000, "Workspace backup preview diagnostics");
    } catch (captureError) {
      console.warn("Could not finish workspace backup preview diagnostics", String(captureError));
    } finally {
      // A timed-out collector must not begin later attachment steps.
      collectionFinished = true;
    }
    throw error;
  } finally {
    page.off("response", onResponse);
    page.off("pageerror", onPageError);
  }
}
