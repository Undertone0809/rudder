import {
  Collapsible,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { NavLink, useLocation } from "@/lib/router";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Project } from "@rudderhq/shared";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { authApi } from "../api/auth";
import { projectsApi } from "../api/projects";
import { useDialog } from "../context/DialogContext";
import { useOrganization } from "../context/OrganizationContext";
import { useSidebar } from "../context/SidebarContext";
import { useProjectOrder } from "../hooks/useProjectOrder";
import { queryKeys } from "../lib/queryKeys";
import { cn, projectRouteRef } from "../lib/utils";
import { ProjectIcon } from "./ProjectIdentity";
import { SidebarSectionActionButton, SidebarSectionHeader } from "./SidebarSectionHeader";
import { sidebarItemVariants } from "./sidebarItemStyles";

function SortableProjectItem({
  activeProjectRef,
  isMobile,
  project,
  setSidebarOpen,
}: {
  activeProjectRef: string | null;
  isMobile: boolean;
  project: Project;
  setSidebarOpen: (open: boolean) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: project.id });

  const routeRef = projectRouteRef(project);

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        zIndex: isDragging ? 10 : undefined,
      }}
      className={cn(isDragging && "opacity-80")}
      {...attributes}
      {...listeners}
    >
      <div className="flex flex-col gap-0.5">
        <NavLink
          to={`/projects/${routeRef}/configuration`}
          onClick={() => {
            if (isMobile) setSidebarOpen(false);
          }}
          className={sidebarItemVariants({
            variant: "compact",
            active: activeProjectRef === routeRef || activeProjectRef === project.id,
          })}
        >
          <ProjectIcon
            color={project.color}
            icon={project.icon}
            size="xs"
            testId={`project-sidebar-color-${project.id}`}
          />
          <span className="flex-1 truncate">{project.name}</span>
        </NavLink>
      </div>
    </div>
  );
}

export function SidebarProjects() {
  const [open, setOpen] = useState(true);
  const { selectedOrganizationId } = useOrganization();
  const { openNewProject } = useDialog();
  const { isMobile, setSidebarOpen } = useSidebar();
  const location = useLocation();

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedOrganizationId!),
    queryFn: () => projectsApi.list(selectedOrganizationId!),
    enabled: !!selectedOrganizationId,
  });
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });

  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;

  const visibleProjects = useMemo(
    () => (projects ?? []).filter((project: Project) => !project.archivedAt),
    [projects],
  );
  const { orderedProjects, persistOrder } = useProjectOrder({
    projects: visibleProjects,
    orgId: selectedOrganizationId,
    userId: currentUserId,
  });

  const projectMatch = location.pathname.match(/^\/(?:[^/]+\/)?projects\/([^/]+)/);
  const activeProjectRef = projectMatch?.[1] ?? null;
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const ids = orderedProjects.map((project) => project.id);
      const oldIndex = ids.indexOf(active.id as string);
      const newIndex = ids.indexOf(over.id as string);
      if (oldIndex === -1 || newIndex === -1) return;

      persistOrder(arrayMove(ids, oldIndex, newIndex));
    },
    [orderedProjects, persistOrder],
  );

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <SidebarSectionHeader
        label="Projects"
        collapsible
        open={open}
        onToggle={() => setOpen((current) => !current)}
        action={(
          <SidebarSectionActionButton
            className={cn(
              "transition-[background-color,color,opacity]",
              !isMobile && "opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto",
            )}
            onClick={(e) => {
              e.stopPropagation();
              openNewProject();
            }}
            aria-label="New project"
            title="Create project"
          >
            <Plus className="h-3 w-3" />
          </SidebarSectionActionButton>
        )}
      />

      <CollapsibleContent>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={orderedProjects.map((project) => project.id)}
            strategy={verticalListSortingStrategy}
          >
            <div className="flex flex-col gap-0.5 mt-0.5">
              {orderedProjects.map((project: Project) => (
                <SortableProjectItem
                  key={project.id}
                  activeProjectRef={activeProjectRef}
                  isMobile={isMobile}
                  project={project}
                  setSidebarOpen={setSidebarOpen}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </CollapsibleContent>
    </Collapsible>
  );
}
