import type { RudderInstalledPlugin, RudderPluginDirectory } from "@rudderhq/shared";
import { Command } from "commander";
import { getAgentCliCapabilityById } from "../../agent-v1-registry.js";
import {
  addCommonClientOptions,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface PluginOptions extends BaseClientOptions {
  orgId?: string;
}

export interface PluginSearchResult {
  installed: RudderPluginDirectory["installed"];
  localApps: RudderPluginDirectory["localApps"];
  discover: RudderPluginDirectory["discover"];
}

function includesQuery(values: unknown[], query: string): boolean {
  return values.some((value) => typeof value === "string" && value.toLocaleLowerCase("en-US").includes(query));
}

export function searchPluginDirectory(directory: RudderPluginDirectory, query: string): PluginSearchResult {
  const normalized = query.trim().toLocaleLowerCase("en-US");
  if (!normalized) return { installed: [], localApps: [], discover: [] };
  return {
    installed: directory.installed.filter((plugin) => includesQuery([
      plugin.id,
      plugin.name,
      plugin.displayName,
      plugin.description,
      plugin.publisher,
      plugin.sourceLabel,
      ...plugin.components.flatMap((component) => [component.key, component.displayName, component.type]),
    ], normalized)),
    localApps: directory.localApps.filter((plugin) => includesQuery([
      plugin.id,
      plugin.appId,
      plugin.name,
      plugin.description,
      plugin.appKey,
    ], normalized)),
    discover: directory.discover.filter((plugin) => includesQuery([
      plugin.reportId,
      plugin.packageId,
      plugin.name,
      plugin.displayName,
      plugin.description,
      plugin.publisher,
      plugin.sourceLabel,
      plugin.category,
      ...plugin.components.flatMap((component) => [component.key, component.name, component.type]),
    ], normalized)),
  };
}

export function registerPluginCommands(program: Command): void {
  const plugin = program.command("plugin").description("Rudder plugin discovery operations");

  addCommonClientOptions(
    plugin
      .command("search")
      .description(getAgentCliCapabilityById("plugin.search").description)
      .argument("<query>", "Plugin name, description, publisher, source, or component")
      .option("-O, --org-id <id>", "Organization ID")
      .action(async (query: string, opts: PluginOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const directory = await ctx.api.get<RudderPluginDirectory>(`/api/orgs/${ctx.orgId}/plugins`);
          if (!directory) throw new Error("Plugin directory response was empty");
          printOutput(searchPluginDirectory(directory, query), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    plugin
      .command("get")
      .description(getAgentCliCapabilityById("plugin.get").description)
      .argument("<pluginId>", "Installed plugin UUID from a plugin:// reference or search result")
      .option("-O, --org-id <id>", "Organization ID")
      .action(async (pluginId: string, opts: PluginOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const row = await ctx.api.get<RudderInstalledPlugin>(`/api/orgs/${ctx.orgId}/plugins/${pluginId}`);
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}
