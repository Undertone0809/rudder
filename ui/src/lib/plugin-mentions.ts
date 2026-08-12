import { rudderPluginsApi } from "@/api/rudderPlugins";
import type { MentionOption } from "@/components/MarkdownEditor";
import type { RudderInstalledPlugin, RudderPluginDirectory } from "@rudderhq/shared";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

export function pluginManagedSkillIds(directory: RudderPluginDirectory | null | undefined) {
  return new Set(
    (directory?.installed ?? []).flatMap((plugin) => plugin.components
      .filter((component) => component.type === "skill" && component.targetId)
      .map((component) => component.targetId!)),
  );
}

function capabilityLabel(plugin: RudderInstalledPlugin) {
  const counts = new Map<string, number>();
  for (const component of plugin.components) {
    if (component.type === "unsupported") continue;
    counts.set(component.type, (counts.get(component.type) ?? 0) + 1);
  }
  return (["app", "skill", "mcp"] as const)
    .flatMap((kind) => {
      const count = counts.get(kind) ?? 0;
      return count ? [`${count} ${kind === "mcp" ? "MCP" : `${kind[0]!.toUpperCase()}${kind.slice(1)}${count === 1 ? "" : "s"}`}`] : [];
    })
    .join(" + ");
}

export function buildPluginMentionOptions(directory: RudderPluginDirectory | null | undefined): MentionOption[] {
  return (directory?.installed ?? [])
    .filter((plugin) => plugin.enabled && plugin.lifecycleState === "installed")
    .map((plugin) => ({
      id: `plugin:${plugin.id}`,
      name: plugin.displayName,
      kind: "plugin" as const,
      searchText: [plugin.displayName, plugin.name, plugin.description, plugin.publisher, capabilityLabel(plugin)]
        .filter(Boolean)
        .join(" "),
      pluginId: plugin.id,
      pluginDescription: plugin.description,
      pluginCapabilityLabel: capabilityLabel(plugin),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function usePluginMentionCatalog(organizationId: string | null | undefined) {
  const directoryQuery = useQuery({
    queryKey: ["rudder-plugins", organizationId],
    queryFn: () => rudderPluginsApi.directory(organizationId!),
    enabled: Boolean(organizationId),
  });
  return useMemo(() => ({
    options: buildPluginMentionOptions(directoryQuery.data),
    managedSkillIds: pluginManagedSkillIds(directoryQuery.data),
    pending: directoryQuery.isPending,
  }), [directoryQuery.data, directoryQuery.isPending]);
}
