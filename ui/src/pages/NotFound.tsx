import { useEffect } from "react";
import { Link, useLocation } from "@/lib/router";
import { AlertTriangle, Compass } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useOrganization } from "../context/OrganizationContext";
import { useI18n } from "../context/I18nContext";

type NotFoundScope = "board" | "invalid_organization_prefix" | "global";

interface NotFoundPageProps {
  scope?: NotFoundScope;
  requestedPrefix?: string;
}

export function NotFoundPage({ scope = "global", requestedPrefix }: NotFoundPageProps) {
  const { t } = useI18n();
  const location = useLocation();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { organizations, selectedOrganization } = useOrganization();

  useEffect(() => {
    setBreadcrumbs([{ label: t("notFound.breadcrumb") }]);
  }, [setBreadcrumbs, t]);

  const fallbackOrganization = selectedOrganization ?? organizations[0] ?? null;
  const dashboardHref = fallbackOrganization ? `/${fallbackOrganization.issuePrefix}/dashboard` : "/";
  const currentPath = `${location.pathname}${location.search}${location.hash}`;
  const normalizedPrefix = requestedPrefix?.toUpperCase();

  const title = scope === "invalid_organization_prefix" ? t("notFound.title.organization") : t("notFound.title.page");
  const description =
    scope === "invalid_organization_prefix"
      ? t("notFound.description.organization", { prefix: normalizedPrefix ?? t("notFound.unknown") })
      : t("notFound.description.page");

  return (
    <div className="mx-auto max-w-2xl py-10">
      <div className="rounded-lg border border-border bg-card p-6">
        <div className="flex items-center gap-3">
          <div className="rounded-md border border-destructive/20 bg-destructive/10 p-2">
            <AlertTriangle className="h-5 w-5 text-destructive" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">{title}</h1>
            <p className="text-sm text-muted-foreground">{description}</p>
          </div>
        </div>

        <div className="mt-4 rounded-md border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          {t("notFound.requestedPath")} <code className="font-mono">{currentPath}</code>
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          <Button asChild>
            <Link to={dashboardHref}>
              <Compass className="mr-1.5 h-4 w-4" />
              {t("notFound.openDashboard")}
            </Link>
          </Button>
          <Button variant="outline" asChild>
            <Link to="/">{t("notFound.goHome")}</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
