import assert from "node:assert/strict";
import test from "node:test";
import { fetchProductAnalyticsReport } from "./product-analytics-report.mjs";

test("fetches only the aggregate report contract", async () => {
  let requestUrl;
  let requestInit;
  const report = await fetchProductAnalyticsReport({
    baseUrl: "https://telemetry.example.test/api/analytics/v1/report",
    secret: "report-secret",
    from: "2026-08-03T00:00:00.000Z",
    to: "2026-08-10T00:00:00.000Z",
    fetchImpl: async (url, init) => {
      requestUrl = String(url);
      requestInit = init;
      return new Response(JSON.stringify({
        window: { timezone: "UTC" },
        metrics: { weeklyCompletedWorkLoops: 3 },
        quality: { acceptedEventCount: 4 },
      }), { status: 200 });
    },
  });
  assert.equal(report.metrics.weeklyCompletedWorkLoops, 3);
  assert.match(requestUrl, /from=2026-08-03T00%3A00%3A00.000Z/);
  assert.equal(requestInit.headers.authorization, "Bearer report-secret");
});

test("rejects non-aggregate or failed report responses", async () => {
  await assert.rejects(
    fetchProductAnalyticsReport({
      baseUrl: "http://127.0.0.1:4318/api/analytics/v1/report",
      secret: "report-secret",
      fetchImpl: async () => new Response(JSON.stringify({ errorCode: "unauthorized" }), { status: 401 }),
    }),
    /unauthorized/,
  );
  await assert.rejects(
    fetchProductAnalyticsReport({
      baseUrl: "http://127.0.0.1:4318/api/analytics/v1/report",
      secret: "report-secret",
      fetchImpl: async () => new Response(JSON.stringify({ window: {}, metrics: {} }), { status: 200 }),
    }),
    /invalid aggregate contract/,
  );
});
