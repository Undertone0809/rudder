import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../program.js";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_ARGV = [...process.argv];

function captureOutput() {
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  return {
    stdout,
    stderr,
    stdoutText: () => stdout.mock.calls.map((call) => String(call[0])).join(""),
    stderrText: () => stderr.mock.calls.map((call) => String(call[0])).join(""),
  };
}

describe("organization brand color CLI command", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    process.argv = [...ORIGINAL_ARGV];
    delete process.env.RUDDER_ORG_ID;
    delete process.env.RUDDER_AGENT_ID;
    delete process.env.RUDDER_RUN_ID;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    process.env = { ...ORIGINAL_ENV };
    process.argv = [...ORIGINAL_ARGV];
  });

  it("sends a scoped branding PATCH with idempotency and Rust authority headers", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: "organization-1",
      brandColor: "#123456",
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const output = captureOutput();
    const args = [
      process.execPath,
      "rudder",
      "org",
      "brand-color",
      "update",
      "--org-id",
      "organization-1",
      "--brand-color",
      " #123456 ",
      "--idempotency-key",
      " brand-color-1 ",
      "--api-base",
      "http://localhost:3100",
      "--api-key",
      "runtime-key",
      "--json",
    ];
    process.argv = args;

    await expect(runCli(args)).resolves.toBe(0);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url).pathname).toBe("/api/orgs/organization-1/branding");
    expect(init.method).toBe("PATCH");
    expect(init.headers).toMatchObject({
      "x-rudder-idempotency-key": "brand-color-1",
      "x-rudder-required-authority": "rust",
    });
    expect(JSON.parse(String(init.body))).toEqual({ brandColor: "#123456" });
    expect(JSON.parse(output.stdoutText())).toEqual({
      id: "organization-1",
      brandColor: "#123456",
    });
  });

  it("reports API failures through the standard JSON error path", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "branding denied" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    })));
    const output = captureOutput();
    const args = [
      process.execPath,
      "rudder",
      "org",
      "brand-color",
      "update",
      "--org-id",
      "organization-1",
      "--brand-color",
      "#123456",
      "--idempotency-key",
      "brand-color-1",
      "--api-base",
      "http://localhost:3100",
      "--api-key",
      "runtime-key",
      "--json",
    ];
    process.argv = args;
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as never);

    await expect(runCli(args)).resolves.toBe(1);

    expect(exit).toHaveBeenCalledWith(1);
    expect(output.stderrText()).toContain('"status": 403');
    expect(output.stderrText()).toContain('"error": "branding denied"');
  });
});
