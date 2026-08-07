import type { PaperclipPluginManifestV1 } from "@rudderhq/shared";
import { describe, expect, it, vi } from "vitest";
import { createPluginToolDispatcher } from "./plugin-tool-dispatcher.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";

const manifest = {
  id: "example.plugin",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Example plugin",
  description: "Exercises database-id worker routing.",
  author: "Rudder",
  categories: ["automation"],
  entrypoints: { worker: "./dist/worker.js" },
  capabilities: ["agent.tools.register"],
  tools: [{
    name: "echo",
    displayName: "Echo",
    description: "Returns the input.",
    parametersSchema: { type: "object" },
  }],
} as PaperclipPluginManifestV1;

describe("plugin tool dispatcher", () => {
  it("routes dynamically registered tools by database id while preserving the plugin-key namespace", async () => {
    const workerManager = {
      isRunning: vi.fn((pluginId: string) => pluginId === "plugin-db-uuid"),
      call: vi.fn(async () => ({ content: "ok" })),
    } as unknown as PluginWorkerManager;
    const dispatcher = createPluginToolDispatcher({ workerManager });

    dispatcher.registerPluginTools("example.plugin", manifest, "plugin-db-uuid");

    expect(dispatcher.getTool("example.plugin:echo")).toMatchObject({
      pluginId: "example.plugin",
      pluginDbId: "plugin-db-uuid",
    });
    await expect(dispatcher.executeTool(
      "example.plugin:echo",
      { message: "hello" },
      {
        agentId: "agent-1",
        runId: "run-1",
        orgId: "org-1",
        projectId: "project-1",
      },
    )).resolves.toMatchObject({
      pluginId: "example.plugin",
      toolName: "echo",
      result: { content: "ok" },
    });
    expect(workerManager.isRunning).toHaveBeenCalledWith("plugin-db-uuid");
    expect(workerManager.call).toHaveBeenCalledWith(
      "plugin-db-uuid",
      "executeTool",
      expect.objectContaining({ toolName: "echo" }),
    );
  });
});
