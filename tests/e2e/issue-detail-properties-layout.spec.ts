import { expect, test, type Page } from "@playwright/test";

async function readResponsiveIssueLayout(page: Page) {
  return page.getByTestId("issue-detail-layout").evaluate((layout) => {
    const heading = layout.querySelector<HTMLElement>("[data-testid='issue-detail-heading']");
    const actions = layout.querySelector<HTMLElement>("[data-testid='issue-detail-actions']");
    const properties = layout.querySelector<HTMLElement>("[data-testid='issue-detail-sidebar']");
    const body = layout.querySelector<HTMLElement>("[data-testid='issue-detail-primary-content']");
    const scrollOwner = layout.closest<HTMLElement>("[data-testid='issue-detail-main-scroll']");
    if (!heading || !actions || !properties || !body || !scrollOwner) return null;

    const layoutBox = layout.getBoundingClientRect();
    const headingBox = heading.getBoundingClientRect();
    const actionsBox = actions.getBoundingClientRect();
    const propertiesBox = properties.getBoundingClientRect();
    const bodyBox = body.getBoundingClientRect();
    const scrollOwnerBox = scrollOwner.getBoundingClientRect();
    const overflowOffender = Array.from(scrollOwner.querySelectorAll<HTMLElement>("*"))
      .map((element) => {
        const box = element.getBoundingClientRect();
        return {
          delta: box.width > 0 && box.height > 0
            ? Math.max(box.right - scrollOwnerBox.right, scrollOwnerBox.left - box.left)
            : Number.NEGATIVE_INFINITY,
          tag: element.tagName.toLowerCase(),
          testId: element.dataset.testid ?? null,
          className: typeof element.className === "string" ? element.className : "",
        };
      })
      .sort((left, right) => right.delta - left.delta)[0] ?? null;
    const visibleProperties = Array.from(layout.querySelectorAll<HTMLElement>("section[aria-label='Issue properties']"))
      .filter((element) => {
        const style = window.getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
      });

    return {
      mode: propertiesBox.left > bodyBox.left + 100 ? "wide" : "compact",
      layoutWidth: Math.round(layoutBox.width),
      bodyWidth: Math.round(bodyBox.width),
      propertiesWidth: Math.round(propertiesBox.width),
      headingBottom: Math.round(headingBox.bottom),
      actionsTop: Math.round(actionsBox.top),
      actionsBottom: Math.round(actionsBox.bottom),
      propertiesTop: Math.round(propertiesBox.top),
      propertiesLeft: Math.round(propertiesBox.left),
      bodyTop: Math.round(bodyBox.top),
      bodyRight: Math.round(bodyBox.right),
      visiblePropertiesCount: visibleProperties.length,
      oneScrollOwner: document.querySelectorAll("[data-testid='issue-detail-main-scroll']").length === 1,
      hasHorizontalOverflow: scrollOwner.scrollWidth > scrollOwner.clientWidth + 1,
      horizontalOverflowAmount: scrollOwner.scrollWidth - scrollOwner.clientWidth,
      overflowOffender,
      gridTemplateColumns: window.getComputedStyle(layout).gridTemplateColumns,
    };
  });
}

test.describe("Issue detail properties layout", () => {
  test("keeps assignee and reviewer identity metadata readable in the sidebar", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");

    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `Issue-Detail-Properties-Layout-${Date.now()}` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string };

    const assigneeRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Ulysses",
        role: "general",
        title: "Chief Operating Officer",
      },
    });
    expect(assigneeRes.ok()).toBe(true);
    const assignee = await assigneeRes.json() as { id: string };

    const reviewerRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Tobias",
        role: "ceo",
        title: "Work Lead / Issue Owner",
      },
    });
    expect(reviewerRes.ok()).toBe(true);
    const reviewer = await reviewerRes.json() as { id: string };

    const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Properties layout should show principal metadata",
        status: "todo",
        priority: "medium",
        assigneeAgentId: assignee.id,
        reviewerAgentId: reviewer.id,
      },
    });
    expect(issueRes.ok()).toBe(true);
    const issue = await issueRes.json() as { id: string; identifier?: string | null };

    await page.goto(`/issues/${issue.identifier ?? issue.id}`);

    const propertiesPanel = page.getByRole("region", { name: "Issue properties" });
    await expect(propertiesPanel).toBeVisible();
    await expect(propertiesPanel.getByText("Ulysses", { exact: true })).toBeVisible();
    await expect(propertiesPanel.getByText("Chief Operating Officer", { exact: true })).toBeVisible();
    await expect(propertiesPanel.getByText("Tobias", { exact: true })).toBeVisible();
    await expect(propertiesPanel.getByText("Work Lead / Issue Owner", { exact: true })).toBeVisible();

    const principalRows = await propertiesPanel.locator('[data-slot="assignee-label"][data-kind="agent"]').evaluateAll((nodes) =>
      nodes.map((node) => {
        const badge = node.querySelector<HTMLElement>('[data-slot="agent-title-badge"]');
        const button = node.closest("button") as HTMLElement | null;

        return {
          layout: node.getAttribute("data-layout"),
          rowClientWidth: node.clientWidth,
          rowScrollWidth: node.scrollWidth,
          triggerClientWidth: button?.clientWidth ?? 0,
          triggerScrollWidth: button?.scrollWidth ?? 0,
          badgeClientWidth: badge?.clientWidth ?? 0,
          badgeScrollWidth: badge?.scrollWidth ?? 0,
        };
      }),
    );

    expect(principalRows).toHaveLength(2);
    for (const row of principalRows) {
      expect(row.layout).toBe("stacked");
      expect(row.rowScrollWidth).toBeLessThanOrEqual(row.rowClientWidth);
      expect(row.triggerScrollWidth).toBeLessThanOrEqual(row.triggerClientWidth);
      expect(row.badgeScrollWidth).toBeLessThanOrEqual(row.badgeClientWidth);
    }
  });

  test("reflows the same Issue Detail through the real Side Panel split and resize workflow", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");

    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `Responsive-Issue-Detail-${Date.now()}` },
    });
    expect(orgRes.ok(), await orgRes.text()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    const projectRes = await page.request.post(`/api/orgs/${organization.id}/projects`, {
      data: {
        name: "Long-running responsive workspace migration project",
        status: "in_progress",
      },
    });
    expect(projectRes.ok(), await projectRes.text()).toBe(true);
    const project = await projectRes.json() as { id: string };

    const goalRes = await page.request.post(`/api/orgs/${organization.id}/goals`, {
      data: {
        title: "Keep every issue surface readable while workspace columns change",
        status: "active",
        level: "organization",
      },
    });
    expect(goalRes.ok(), await goalRes.text()).toBe(true);
    const goal = await goalRes.json() as { id: string };

    const assigneeRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Responsive Layout Investigator",
        role: "general",
        title: "Principal Work Surface Reliability Engineer",
      },
    });
    expect(assigneeRes.ok(), await assigneeRes.text()).toBe(true);
    const assignee = await assigneeRes.json() as { id: string };

    const parentRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Parent issue with a deliberately long title that must never force horizontal page overflow",
        status: "todo",
        priority: "high",
        projectId: project.id,
        goalId: goal.id,
      },
    });
    expect(parentRes.ok(), await parentRes.text()).toBe(true);
    const parentIssue = await parentRes.json() as { id: string };

    const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Issue Detail should respond to its own available inline size without losing editable state or evidence",
        description: "This populated description stays readable while the global Side Panel opens, resizes, and closes. ".repeat(20),
        status: "todo",
        priority: "medium",
        projectId: project.id,
        goalId: goal.id,
        parentId: parentIssue.id,
        assigneeAgentId: assignee.id,
      },
    });
    expect(issueRes.ok(), await issueRes.text()).toBe(true);
    const issue = await issueRes.json() as { id: string; identifier?: string | null };
    const issueRef = issue.identifier ?? issue.id;

    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
      window.localStorage.removeItem("rudder.workspace.sidePanelWidth.v2");
    }, organization.id);
    await page.goto(`/${organization.issuePrefix}/issues/${issueRef}`);

    const layout = page.getByTestId("issue-detail-layout");
    const routeBeforeSplit = page.url();
    await expect(layout).toBeVisible();
    await expect(page.getByRole("button", { name: "Copy ID" })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Chat", exact: true })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "More issue actions" })).toHaveCount(1);

    await expect.poll(() => readResponsiveIssueLayout(page)).toMatchObject({
      mode: "wide",
      visiblePropertiesCount: 1,
      oneScrollOwner: true,
      hasHorizontalOverflow: false,
      propertiesWidth: 280,
    });
    const wide = await readResponsiveIssueLayout(page);
    expect(wide).not.toBeNull();
    expect(wide!.gridTemplateColumns).toContain("280px");
    expect(wide!.propertiesLeft).toBeGreaterThan(wide!.bodyRight);
    await page.screenshot({
      path: testInfo.outputPath("issue-detail-responsive-wide-light.png"),
      fullPage: false,
    });

    await layout.evaluate((element) => {
      element.setAttribute("data-persistence-probe", "same-node");
    });
    await page.getByTestId("side-panel-hover-edge").hover();
    await page.getByTestId("global-side-panel-trigger").click();
    const sidePanel = page.getByTestId("chat-side-panel");
    await expect(sidePanel).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(routeBeforeSplit);
    await expect(layout).toHaveAttribute("data-persistence-probe", "same-node");
    await expect.poll(() => readResponsiveIssueLayout(page)).toMatchObject({
      mode: "compact",
      visiblePropertiesCount: 1,
      oneScrollOwner: true,
    });
    const compact = await readResponsiveIssueLayout(page);
    expect(compact).not.toBeNull();
    expect(
      compact!.hasHorizontalOverflow,
      JSON.stringify({
        amount: compact!.horizontalOverflowAmount,
        offender: compact!.overflowOffender,
      }),
    ).toBe(false);
    expect(compact!.propertiesWidth).toBeGreaterThan(compact!.layoutWidth - 2);
    expect(compact!.headingBottom).toBeLessThanOrEqual(compact!.actionsTop);
    expect(compact!.actionsBottom).toBeLessThan(compact!.propertiesTop);
    expect(compact!.propertiesTop).toBeLessThan(compact!.bodyTop);
    await page.screenshot({
      path: testInfo.outputPath("issue-detail-responsive-split-light.png"),
      fullPage: false,
    });

    await page.evaluate(() => window.localStorage.setItem("rudder.theme", "dark"));
    await page.reload();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.getByTestId("side-panel-hover-edge").hover();
    await page.getByTestId("global-side-panel-trigger").click();
    await expect(page.getByTestId("chat-side-panel")).toBeVisible();
    await expect.poll(() => readResponsiveIssueLayout(page)).toMatchObject({ mode: "compact" });
    await page.screenshot({
      path: testInfo.outputPath("issue-detail-responsive-split-dark.png"),
      fullPage: false,
    });
    await page.evaluate(() => window.localStorage.setItem("rudder.theme", "light"));
    await page.reload();
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await page.getByTestId("side-panel-hover-edge").hover();
    await page.getByTestId("global-side-panel-trigger").click();
    await expect(page.getByTestId("chat-side-panel")).toBeVisible();

    await page.setViewportSize({ width: 1920, height: 900 });
    await expect.poll(() => readResponsiveIssueLayout(page)).toMatchObject({ mode: "compact" });
    const issueScroll = page.getByTestId("issue-detail-main-scroll");
    const activityEditor = page
      .getByTestId("comment-thread-fixed-composer")
      .locator('[contenteditable="true"]');
    const preservedDraft = "Keep this unsaved draft and focus across the responsive threshold.";
    await activityEditor.scrollIntoViewIfNeeded();
    await activityEditor.fill(preservedDraft);
    await expect(activityEditor).toBeFocused();
    const preservedScrollTop = await issueScroll.evaluate((element) => {
      element.scrollTop = Math.min(180, element.scrollHeight - element.clientHeight);
      return element.scrollTop;
    });
    expect(preservedScrollTop).toBeGreaterThan(0);
    const resizerBox = await page.getByTestId("side-panel-resizer-hit-target").boundingBox();
    expect(resizerBox).not.toBeNull();
    const resizerY = resizerBox!.y + resizerBox!.height / 2;
    await page.mouse.move(resizerBox!.x + resizerBox!.width / 2, resizerY);
    await page.mouse.down();
    await expect(page.getByTestId("side-panel-resize-shield")).toBeVisible();
    await page.mouse.move(1920 - 350, resizerY, { steps: 10 });
    await page.mouse.up();
    await expect(page.getByTestId("side-panel-resize-shield")).toHaveCount(0);
    await expect.poll(() => readResponsiveIssueLayout(page)).toMatchObject({
      mode: "wide",
      visiblePropertiesCount: 1,
      hasHorizontalOverflow: false,
    });
    await expect(activityEditor).toContainText(preservedDraft);
    await expect.poll(() => activityEditor.evaluate((element) => (
      document.activeElement === element || element.contains(document.activeElement)
    ))).toBe(true);
    await expect.poll(() => issueScroll.evaluate((element) => element.scrollTop)).toBe(preservedScrollTop);
    await page.screenshot({
      path: testInfo.outputPath("issue-detail-responsive-resized-wide-light.png"),
      fullPage: false,
    });

    const resizedResizerBox = await page.getByTestId("side-panel-resizer-hit-target").boundingBox();
    expect(resizedResizerBox).not.toBeNull();
    const resizedY = resizedResizerBox!.y + resizedResizerBox!.height / 2;
    await page.mouse.move(resizedResizerBox!.x + resizedResizerBox!.width / 2, resizedY);
    await page.mouse.down();
    await expect(page.getByTestId("side-panel-resize-shield")).toBeVisible();
    await page.mouse.move(1920 - 710, resizedY, { steps: 10 });
    await page.mouse.up();
    await expect(page.getByTestId("side-panel-resize-shield")).toHaveCount(0);
    await expect.poll(() => readResponsiveIssueLayout(page)).toMatchObject({ mode: "compact" });
    await expect(activityEditor).toContainText(preservedDraft);
    await expect.poll(() => activityEditor.evaluate((element) => (
      document.activeElement === element || element.contains(document.activeElement)
    ))).toBe(true);
    await expect.poll(() => issueScroll.evaluate((element) => element.scrollTop)).toBe(preservedScrollTop);

    await sidePanel.getByLabel("Close Side Panel").click();
    await expect(sidePanel).toHaveCount(0);
    await expect(page).toHaveURL(routeBeforeSplit);
    await expect.poll(() => readResponsiveIssueLayout(page)).toMatchObject({
      mode: "wide",
      visiblePropertiesCount: 1,
      oneScrollOwner: true,
      hasHorizontalOverflow: false,
    });
    await page.evaluate(() => window.localStorage.setItem("rudder.theme", "dark"));
    await page.reload();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.screenshot({
      path: testInfo.outputPath("issue-detail-responsive-restored-dark.png"),
      fullPage: false,
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole("button", { name: "Properties" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Issue properties" })).toBeHidden();
    await page.getByRole("button", { name: "Properties" }).click();
    await expect(page.getByRole("dialog", { name: "Properties" })).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Properties" })).toContainText("Responsive Layout Investigator");
    await page.screenshot({
      path: testInfo.outputPath("issue-detail-responsive-phone-dark.png"),
      fullPage: false,
    });
  });
});
