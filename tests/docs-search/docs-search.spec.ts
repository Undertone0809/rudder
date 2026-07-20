import { expect, test } from "@playwright/test";

test("finds an English docs page and opens it from the keyboard", async ({ page }) => {
  await page.goto("/?search=gdpval");

  const input = page.locator('[data-component-part="search-input"]');
  await expect(input).toHaveValue("gdpval");

  const benchmark = page.locator('a[data-rudder-search-result][href="/benchmarks/gdpval-harness"]');
  await expect(benchmark).toBeVisible();
  await expect(benchmark).toContainText("GDPval Harness Benchmark");

  await input.press("ArrowDown");
  await expect(benchmark).toHaveAttribute("data-highlighted", "");
  await input.press("Enter");
  await expect(page).toHaveURL(/\/benchmarks\/gdpval-harness$/);
});

test("keeps Chinese search scoped and shows a real empty state", async ({ page }) => {
  await page.goto("/zh?search=预算");

  const input = page.locator('[data-component-part="search-input"]');
  const searchList = page.locator('[data-component-part="search-list"]');
  const results = page.locator("a[data-rudder-search-result]");
  await expect(results.first()).toBeVisible();

  const hrefs = await results.evaluateAll((links) => links.map((link) => link.getAttribute("href")));
  expect(hrefs.length).toBeGreaterThan(0);
  expect(hrefs.every((href) => href?.startsWith("/zh"))).toBe(true);
  await expect(searchList.getByText("文档", { exact: true })).toBeVisible();

  await input.fill("definitely-no-rudder-doc-matches-this-query");
  await expect(results).toHaveCount(0);
  await expect(searchList.getByText("未找到结果", { exact: true })).toBeVisible();
  await expect(page.locator('[role="status"]', { hasText: "结果：0" })).toHaveCount(1);
});

test("clears stale keyboard selection when the query or dialog is reset", async ({ page }) => {
  await page.goto("/?search=gdpval");

  const input = page.locator('[data-component-part="search-input"]');
  const results = page.locator("a[data-rudder-search-result]");
  await expect(results.first()).toBeVisible();
  await input.press("ArrowDown");
  await expect(input).toHaveAttribute("aria-activedescendant", /rudder-search-result-/);

  await input.fill("");
  await expect(results).toHaveCount(0);
  await expect(input).not.toHaveAttribute("aria-activedescendant", /.+/);
  const emptyQueryUrl = page.url();
  await input.press("Enter");
  await expect(page).toHaveURL(emptyQueryUrl);

  await page.keyboard.press("Escape");
  const searchTrigger = page.locator("button").filter({ hasText: "Search...", visible: true });
  await expect(searchTrigger).toHaveCount(1);
  await searchTrigger.click();

  const reopenedInput = page.locator('[data-component-part="search-input"]');
  await expect(reopenedInput).toHaveValue("");
  await expect(reopenedInput).not.toHaveAttribute("aria-activedescendant", /.+/);
  const reopenedUrl = page.url();
  await reopenedInput.press("Enter");
  await expect(page).toHaveURL(reopenedUrl);
});
