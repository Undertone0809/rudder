import { Navigate } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { Hexagon } from "lucide-react";
import { useEffect, useMemo } from "react";
import { projectsApi } from "../api/projects";
import { EmptyState } from "../components/EmptyState";
import { EntityRow } from "../components/EntityRow";
import { PageSkeleton } from "../components/PageSkeleton";
import { ProjectIcon } from "../components/ProjectIdentity";
import { StatusBadge } from "../components/StatusBadge";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useDialog } from "../context/DialogContext";
import { useOrganization } from "../context/OrganizationContext";
import { queryKeys } from "../lib/queryKeys";
import { formatDate, projectUrl } from "../lib/utils";

export function Projects() {
  const { selectedOrganizationId } = useOrganization();
  const { openNewProject } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Projects" }]);
  }, [setBreadcrumbs]);

  const { data: allProjects, isLoading, error } = useQuery({
    queryKey: queryKeys.projects.list(selectedOrganizationId!),
    queryFn: () => projectsApi.list(selectedOrganizationId!),
    enabled: !!selectedOrganizationId,
  });
  const projects = useMemo(
    () => (allProjects ?? []).filter((p) => !p.archivedAt),
    [allProjects],
  );

  if (!selectedOrganizationId) {
    return <EmptyState icon={Hexagon} message="Select a organization to view projects." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  if (projects.length > 0) {
    return <Navigate to={projectUrl(projects[0]!)} replace />;
  }

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {!isLoading && projects.length === 0 && (
        <EmptyState
          icon={Hexagon}
          message="No projects yet."
          action="Add Project"
          onAction={openNewProject}
        />
      )}

      {projects.length > 0 && (
        <div className="border border-border">
          {projects.map((project) => (
            <EntityRow
              key={project.id}
              title={project.name}
              subtitle={project.description ?? undefined}
              to={projectUrl(project)}
              leading={<ProjectIcon color={project.color} icon={project.icon} size="md" />}
              trailing={
                <div className="flex items-center gap-3">
                  {project.targetDate && (
                    <span className="text-xs text-muted-foreground">
                      {formatDate(project.targetDate)}
                    </span>
                  )}
                  <StatusBadge status={project.status} />
                </div>
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
