import path from "node:path";
import { describe, expect, it } from "vitest";

import playwrightConfig from "../../../tests/e2e/playwright.config";
import { E2E_HOME, E2E_INSTANCE_ID, E2E_INSTANCE_ROOT } from "../../../tests/e2e/support/e2e-env";

describe("playwright e2e webServer environment", () => {
  it("clears inherited runtime overrides and points server dev at the isolated e2e config", () => {
    const webServer = playwrightConfig.webServer;
    expect(webServer).toBeDefined();
    expect(typeof webServer).toBe("object");
    const command = (webServer as { command: string }).command;

    expect(command).toContain(
      "unset HOST PORT RUDDER_API_URL RUDDER_EMBEDDED_POSTGRES_PORT RUDDER_LISTEN_HOST RUDDER_LISTEN_PORT RUDDER_LOCAL_ENV RUDDER_RUNTIME_OWNER_KIND;",
    );
    expect(command).toContain(`RUDDER_HOME="${E2E_HOME}"`);
    expect(command).toContain(`RUDDER_CONFIG="${path.join(E2E_INSTANCE_ROOT, "config.json")}"`);
    expect(command).toContain(`RUDDER_INSTANCE_ID="${E2E_INSTANCE_ID}"`);
    expect(command).toContain('RUDDER_LOCAL_ENV="e2e"');
  });
});
