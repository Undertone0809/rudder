import { useEffect, useMemo } from "react";
import { Link, Navigate, useParams } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { useOrganization } from "@/context/OrganizationContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { pluginsApi } from "@/api/plugins";
import { queryKeys } from "@/lib/queryKeys";
import { PluginSlotMount } from "@/plugins/slots";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import { NotFoundPage } from "./NotFound";

/**
 * Organization-context plugin page. Renders a plugin's `page` slot at
 * `/:orgPrefix/plugins/:pluginId` when the plugin declares a page slot
 * and is enabled for that organization.
 *
 * @see doc/plugins/PLUGIN_SPEC.md §19.2 — Organization-Context Routes
 * @see doc/plugins/PLUGIN_SPEC.md §24.4 — Organization-Context Plugin Page
 */
export function PluginPage() {
  const { orgPrefix: routeOrganizationPrefix, pluginId, pluginRoutePath } = useParams<{
    orgPrefix?: string;
    pluginId?: string;
    pluginRoutePath?: string;
  }>();
  const { organizations, selectedOrganizationId } = useOrganization();
  const { setBreadcrumbs } = useBreadcrumbs();
  const routeOrganization = useMemo(() => {
    if (!routeOrganizationPrefix) return null;
    const requested = routeOrganizationPrefix.toUpperCase();
    return organizations.find((c) => c.issuePrefix.toUpperCase() === requested) ?? null;
  }, [organizations, routeOrganizationPrefix]);
  const hasInvalidOrganizationPrefix = Boolean(routeOrganizationPrefix) && !routeOrganization;

  const resolvedOrganizationId = useMemo(() => {
    if (routeOrganization) return routeOrganization.id;
    if (routeOrganizationPrefix) return null;
    return selectedOrganizationId ?? null;
  }, [routeOrganization, routeOrganizationPrefix, selectedOrganizationId]);

  const orgPrefix = useMemo(
    () => (resolvedOrganizationId ? organizations.find((c) => c.id === resolvedOrganizationId)?.issuePrefix ?? null : null),
    [organizations, resolvedOrganizationId],
  );

  const { data: contributions } = useQuery({
    queryKey: queryKeys.plugins.uiContributions,
    queryFn: () => pluginsApi.listUiContributions(),
    enabled: !!resolvedOrganizationId && (!!pluginId || !!pluginRoutePath),
  });

  const pageSlot = useMemo(() => {
    if (!contributions) return null;
    if (pluginId) {
      const contribution = contributions.find((c) => c.pluginId === pluginId);
      if (!contribution) return null;
      const slot = contribution.slots.find((s) => s.type === "page");
      if (!slot) return null;
      return {
        ...slot,
        pluginId: contribution.pluginId,
        pluginKey: contribution.pluginKey,
        pluginDisplayName: contribution.displayName,
        pluginVersion: contribution.version,
      };
    }
    if (!pluginRoutePath) return null;
    const matches = contributions.flatMap((contribution) => {
      const slot = contribution.slots.find((entry) => entry.type === "page" && entry.routePath === pluginRoutePath);
      if (!slot) return [];
      return [{
        ...slot,
        pluginId: contribution.pluginId,
        pluginKey: contribution.pluginKey,
        pluginDisplayName: contribution.displayName,
        pluginVersion: contribution.version,
      }];
    });
    if (matches.length !== 1) return null;
    return matches[0] ?? null;
  }, [pluginId, pluginRoutePath, contributions]);

  const context = useMemo(
    () => ({
      orgId: resolvedOrganizationId ?? null,
      orgPrefix,
    }),
    [resolvedOrganizationId, orgPrefix],
  );

  useEffect(() => {
    if (pageSlot) {
      setBreadcrumbs([
        { label: "Plugins", href: "/instance/settings/plugins" },
        { label: pageSlot.pluginDisplayName },
      ]);
    }
  }, [pageSlot, orgPrefix, setBreadcrumbs]);

  if (!resolvedOrganizationId) {
    if (hasInvalidOrganizationPrefix) {
      return <NotFoundPage scope="invalid_organization_prefix" requestedPrefix={routeOrganizationPrefix} />;
    }
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">Select a organization to view this page.</p>
      </div>
    );
  }

  if (!contributions) {
    return <div className="text-sm text-muted-foreground">Loading…</div>;
  }

  if (!pluginId && pluginRoutePath) {
    const duplicateMatches = contributions.filter((contribution) =>
      contribution.slots.some((slot) => slot.type === "page" && slot.routePath === pluginRoutePath),
    );
    if (duplicateMatches.length > 1) {
      return (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          Multiple plugins declare the route <code>{pluginRoutePath}</code>. Use the plugin-id route until the conflict is resolved.
        </div>
      );
    }
  }

  if (!pageSlot) {
    if (pluginRoutePath) {
      return <NotFoundPage scope="board" />;
    }
    // No page slot: redirect to plugin settings where plugin info is always shown
    const settingsPath = pluginId ? `/instance/settings/plugins/${pluginId}` : "/instance/settings/plugins";
    return <Navigate to={settingsPath} replace />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" asChild>
          <Link to={orgPrefix ? `/${orgPrefix}/dashboard` : "/dashboard"}>
            <ArrowLeft className="h-4 w-4 mr-1" />
            Back
          </Link>
        </Button>
      </div>
      <PluginSlotMount
        slot={pageSlot}
        context={context}
        className="min-h-[200px]"
        missingBehavior="placeholder"
      />
    </div>
  );
}
