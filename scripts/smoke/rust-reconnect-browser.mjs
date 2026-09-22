// Run with RUDDER_RECONNECT_FIXTURE_LOG=<fixture log> ego-browser nodejs < this file.
// The companion fixture owns a disposable UI/API/Actix/PostgreSQL instance.
const { readFile } = await import("node:fs/promises");
const { default: assert } = await import("node:assert/strict");
const logPath = process.env.RUDDER_RECONNECT_FIXTURE_LOG;
assert.ok(logPath, "Set RUDDER_RECONNECT_FIXTURE_LOG to the running disposable fixture log");
const line = (await readFile(logPath, "utf8")).split("\n")
  .find((entry) => entry.startsWith('{"marker":"RUST_RECONNECT_UI_READY"'));
assert.ok(line, "Fixture must be ready before starting browser acceptance");
const fixture = JSON.parse(line);
assert.ok(fixture.apiUrl.startsWith("http://127.0.0.1:"), "Only a disposable loopback fixture is supported");
const task = await taskSpace(process.env.RUDDER_EGO_TASK_SPACE
  ? Number(process.env.RUDDER_EGO_TASK_SPACE) : "Rudder Rust reconnect workflow");
const page = task.page("p1");
console.log({ spaceId: task.spaceId });
await page.cdp("Page.addScriptToEvaluateOnNewDocument", { source: `
  window.__wsRecovery = { sockets: [], responses: [], paused: false };
  const OriginalSocket = window.WebSocket;
  window.WebSocket = new Proxy(OriginalSocket, { construct(target, args) {
    if (window.__wsRecovery.paused) args = ['ws://127.0.0.1:1'];
    const socket = new target(...args);
    window.__wsRecovery.sockets.push(socket);
    return socket;
  }});
  const originalFetch = window.fetch;
  window.fetch = async function(...args) {
    const response = await originalFetch.apply(this, args);
    if (response.url.includes('/api/projects/')) response.clone().json()
      .then(body => window.__wsRecovery.responses.push({ url: response.url, body })).catch(() => {});
    return response;
  };
` });
await page.goto(`${fixture.apiUrl}/${fixture.org.urlKey}/projects/${fixture.project.urlKey}/configuration`);
await page.waitForFunction(() => window.__wsRecovery?.sockets.some((socket) => socket.readyState === 1)
  && window.__wsRecovery.responses.length > 0);
await page.screenshot({ path: "/tmp/rudder-branding-ws-reconnect-before.png" });
await page.evaluate(() => {
  window.__wsRecovery.beforeImage = document.querySelector('button[aria-label="Organization menu"] img')?.src;
  window.__wsRecovery.paused = true;
  window.__wsRecovery.sockets.forEach((socket) => socket.close());
});
for (const [route, body, key] of [
  [`/orgs/${fixture.org.id}/branding`, { brandColor: "#22bb66" }, "branding"],
  [`/projects/${fixture.project.id}`, { goalIds: [fixture.goalB.id] }, "goal"],
]) {
  const response = await fetch(`${fixture.apiUrl}/api${route}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-rudder-required-authority": "rust", "x-rudder-idempotency-key": `ws-reconnect-${key}-${fixture.org.id}` },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200, await response.text());
}
await page.waitForFunction(() => window.__wsRecovery.sockets.some((socket) => socket.url === "ws://127.0.0.1:1/" && socket.readyState === 3));
const disconnected = await page.evaluate(() => ({
  online: navigator.onLine,
  liveSockets: window.__wsRecovery.sockets.filter((socket) => socket.readyState === 1).length,
  unchangedImage: window.__wsRecovery.beforeImage === document.querySelector('button[aria-label="Organization menu"] img')?.src,
  projectReads: window.__wsRecovery.responses.length,
}));
assert.deepEqual(disconnected, { online: true, liveSockets: 0, unchangedImage: true, projectReads: 1 });
await page.evaluate(() => { window.__wsRecovery.paused = false; });
await page.waitForFunction((goalId) => window.__wsRecovery.sockets.some((socket) => socket.readyState === 1)
  && window.__wsRecovery.responses.some((response) => response.body.goalIds?.includes(goalId))
  && window.__wsRecovery.beforeImage !== document.querySelector('button[aria-label="Organization menu"] img')?.src,
fixture.goalB.id, { timeout: 30_000 });
await page.screenshot({ path: "/tmp/rudder-branding-ws-reconnect-after.png" });
console.log({ marker: "RUST_WEBSOCKET_RECONNECT_PASS", disconnected, fixturePid: fixture.pid, organizationId: fixture.org.id, projectId: fixture.project.id });
await task.finish({ keep: [] });
