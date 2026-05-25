import { useEffect, useMemo, useState } from "react";
import {
  Bot,
  Boxes,
  CheckCircle2,
  Component,
  DollarSign,
  FileText,
  FlaskConical,
  Gauge,
  Inbox,
  LayoutDashboard,
  ListFilter,
  ListTodo,
  Search,
  Shapes,
  ShieldAlert,
  Workflow,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ActivityEvent, Agent, AgentRole, Approval, Issue } from "@rudderhq/shared";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback, AvatarGroup, AvatarGroupCount } from "@/components/ui/avatar";
import { StatusBadge } from "@/components/StatusBadge";
import { StatusIcon } from "@/components/StatusIcon";
import { PriorityIcon } from "@/components/PriorityIcon";
import { EntityRow } from "@/components/EntityRow";
import { EmptyState } from "@/components/EmptyState";
import { MetricCard } from "@/components/MetricCard";
import { FilterBar, type FilterValue } from "@/components/FilterBar";
import { InlineEditor } from "@/components/InlineEditor";
import { PageSkeleton } from "@/components/PageSkeleton";
import { Identity } from "@/components/Identity";
import { AgentIdentity } from "@/components/AgentAvatar";
import { AgentMenuLabel, AssigneeLabel, AssigneeSelfActionLabel } from "@/components/AssigneeLabel";
import { IssueLabelChip } from "@/components/IssueLabelChip";
import { ActivityRow } from "@/components/ActivityRow";
import { ApprovalCard } from "@/components/ApprovalCard";
import { CopyText } from "@/components/CopyText";
import { IssueRow } from "@/components/IssueRow";
import { PauseResumeButton, RunButton } from "@/components/AgentActionButtons";
import { TextDots } from "@/components/TextDots";
import { QuotaBar } from "@/components/QuotaBar";
import { HoverTimestampLabel } from "@/components/HoverTimestamp";
import { DesignGuide } from "./DesignGuide";
import { RunTranscriptUxLab } from "./RunTranscriptUxLab";
import { cn } from "@/lib/utils";

type UiLabSectionId = "overview" | "primitives" | "common" | "design-guide" | "transcripts" | "coverage";

type CoverageStatus =
  | "covered"
  | "fixture-backed"
  | "context-required"
  | "not-renderable"
  | "deprecated"
  | "missing-example";

type CoverageCategory = "primitive" | "product" | "pattern" | "workflow" | "shell" | "helper";

type CoverageEntry = {
  componentId: string;
  category: CoverageCategory;
  sourcePath: string;
  status: CoverageStatus;
  exampleKind: "direct" | "fixture" | "module" | "registry-only" | "excluded";
  gaps?: string;
};

const sectionOptions: Array<{
  id: UiLabSectionId;
  label: string;
  description: string;
  icon: LucideIcon;
}> = [
  {
    id: "overview",
    label: "Overview",
    description: "Inventory model, status counts, and contributor rules.",
    icon: LayoutDashboard,
  },
  {
    id: "primitives",
    label: "Primitives",
    description: "Base controls from components/ui.",
    icon: Shapes,
  },
  {
    id: "common",
    label: "Common Components",
    description: "Frequently reused Rudder product components with fixtures.",
    icon: Component,
  },
  {
    id: "design-guide",
    label: "Design Guide",
    description: "The existing full design guide, preserved inside the lab.",
    icon: FileText,
  },
  {
    id: "transcripts",
    label: "Run Transcripts",
    description: "Fixture-backed transcript UX surfaces.",
    icon: Workflow,
  },
  {
    id: "coverage",
    label: "Coverage",
    description: "Searchable registry of covered, pending, and excluded surfaces.",
    icon: ListFilter,
  },
];

const statusLabels: Record<CoverageStatus, string> = {
  "covered": "Covered",
  "fixture-backed": "Fixture-backed",
  "context-required": "Context required",
  "not-renderable": "Not renderable",
  "deprecated": "Deprecated",
  "missing-example": "Missing example",
};

const statusClassNames: Record<CoverageStatus, string> = {
  "covered": "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  "fixture-backed": "border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
  "context-required": "border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  "not-renderable": "border-border bg-muted/50 text-muted-foreground",
  "deprecated": "border-destructive/30 bg-destructive/10 text-destructive",
  "missing-example": "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
};

export const uiLabCoverage: CoverageEntry[] = [
  { componentId: "Button", category: "primitive", sourcePath: "ui/src/components/ui/button.tsx", status: "covered", exampleKind: "direct" },
  { componentId: "Badge", category: "primitive", sourcePath: "ui/src/components/ui/badge.tsx", status: "covered", exampleKind: "direct" },
  { componentId: "Input", category: "primitive", sourcePath: "ui/src/components/ui/input.tsx", status: "covered", exampleKind: "direct" },
  { componentId: "Textarea", category: "primitive", sourcePath: "ui/src/components/ui/textarea.tsx", status: "covered", exampleKind: "direct" },
  { componentId: "Checkbox", category: "primitive", sourcePath: "ui/src/components/ui/checkbox.tsx", status: "covered", exampleKind: "direct" },
  { componentId: "Label", category: "primitive", sourcePath: "ui/src/components/ui/label.tsx", status: "covered", exampleKind: "direct" },
  { componentId: "Select", category: "primitive", sourcePath: "ui/src/components/ui/select.tsx", status: "covered", exampleKind: "direct" },
  { componentId: "Tabs", category: "primitive", sourcePath: "ui/src/components/ui/tabs.tsx", status: "covered", exampleKind: "direct" },
  { componentId: "ToggleSwitch", category: "primitive", sourcePath: "ui/src/components/ui/toggle-switch.tsx", status: "covered", exampleKind: "direct" },
  { componentId: "Avatar", category: "primitive", sourcePath: "ui/src/components/ui/avatar.tsx", status: "covered", exampleKind: "direct" },
  { componentId: "Skeleton", category: "primitive", sourcePath: "ui/src/components/ui/skeleton.tsx", status: "covered", exampleKind: "direct" },
  { componentId: "Separator", category: "primitive", sourcePath: "ui/src/components/ui/separator.tsx", status: "covered", exampleKind: "direct" },
  { componentId: "Dialog", category: "primitive", sourcePath: "ui/src/components/ui/dialog.tsx", status: "covered", exampleKind: "module" },
  { componentId: "Sheet", category: "primitive", sourcePath: "ui/src/components/ui/sheet.tsx", status: "covered", exampleKind: "module" },
  { componentId: "DropdownMenu", category: "primitive", sourcePath: "ui/src/components/ui/dropdown-menu.tsx", status: "covered", exampleKind: "module" },
  { componentId: "Popover", category: "primitive", sourcePath: "ui/src/components/ui/popover.tsx", status: "covered", exampleKind: "module" },
  { componentId: "Tooltip", category: "primitive", sourcePath: "ui/src/components/ui/tooltip.tsx", status: "covered", exampleKind: "module" },
  { componentId: "Command", category: "primitive", sourcePath: "ui/src/components/ui/command.tsx", status: "covered", exampleKind: "module" },
  { componentId: "Breadcrumb", category: "primitive", sourcePath: "ui/src/components/ui/breadcrumb.tsx", status: "covered", exampleKind: "module" },
  { componentId: "ScrollArea", category: "primitive", sourcePath: "ui/src/components/ui/scroll-area.tsx", status: "covered", exampleKind: "module" },
  { componentId: "Card", category: "primitive", sourcePath: "ui/src/components/ui/card.tsx", status: "covered", exampleKind: "module" },
  { componentId: "Collapsible", category: "primitive", sourcePath: "ui/src/components/ui/collapsible.tsx", status: "covered", exampleKind: "module" },
  { componentId: "StatusBadge", category: "product", sourcePath: "ui/src/components/StatusBadge.tsx", status: "covered", exampleKind: "direct" },
  { componentId: "StatusIcon", category: "product", sourcePath: "ui/src/components/StatusIcon.tsx", status: "covered", exampleKind: "direct" },
  { componentId: "PriorityIcon", category: "product", sourcePath: "ui/src/components/PriorityIcon.tsx", status: "covered", exampleKind: "direct" },
  { componentId: "EntityRow", category: "product", sourcePath: "ui/src/components/EntityRow.tsx", status: "covered", exampleKind: "direct" },
  { componentId: "EmptyState", category: "product", sourcePath: "ui/src/components/EmptyState.tsx", status: "covered", exampleKind: "direct" },
  { componentId: "MetricCard", category: "product", sourcePath: "ui/src/components/MetricCard.tsx", status: "covered", exampleKind: "direct" },
  { componentId: "FilterBar", category: "product", sourcePath: "ui/src/components/FilterBar.tsx", status: "covered", exampleKind: "direct" },
  { componentId: "InlineEditor", category: "product", sourcePath: "ui/src/components/InlineEditor.tsx", status: "covered", exampleKind: "direct" },
  { componentId: "PageSkeleton", category: "product", sourcePath: "ui/src/components/PageSkeleton.tsx", status: "covered", exampleKind: "direct" },
  { componentId: "Identity", category: "product", sourcePath: "ui/src/components/Identity.tsx", status: "covered", exampleKind: "direct" },
  { componentId: "AgentIdentity", category: "product", sourcePath: "ui/src/components/AgentAvatar.tsx", status: "covered", exampleKind: "direct" },
  { componentId: "AssigneeLabel", category: "product", sourcePath: "ui/src/components/AssigneeLabel.tsx", status: "covered", exampleKind: "direct" },
  { componentId: "IssueLabelChip", category: "product", sourcePath: "ui/src/components/IssueLabelChip.tsx", status: "covered", exampleKind: "direct" },
  { componentId: "ActivityRow", category: "product", sourcePath: "ui/src/components/ActivityRow.tsx", status: "fixture-backed", exampleKind: "fixture" },
  { componentId: "IssueRow", category: "product", sourcePath: "ui/src/components/IssueRow.tsx", status: "fixture-backed", exampleKind: "fixture" },
  { componentId: "ApprovalCard", category: "product", sourcePath: "ui/src/components/ApprovalCard.tsx", status: "fixture-backed", exampleKind: "fixture" },
  { componentId: "AgentActionButtons", category: "product", sourcePath: "ui/src/components/AgentActionButtons.tsx", status: "covered", exampleKind: "direct" },
  { componentId: "CommandPalette", category: "shell", sourcePath: "ui/src/components/CommandPalette.tsx", status: "context-required", exampleKind: "registry-only", gaps: "Global app command surface; opened through app shell keyboard/event context." },
  { componentId: "CopyText", category: "product", sourcePath: "ui/src/components/CopyText.tsx", status: "covered", exampleKind: "direct" },
  { componentId: "TextDots", category: "product", sourcePath: "ui/src/components/TextDots.tsx", status: "covered", exampleKind: "direct" },
  { componentId: "QuotaBar", category: "product", sourcePath: "ui/src/components/QuotaBar.tsx", status: "covered", exampleKind: "direct" },
  { componentId: "HoverTimestampLabel", category: "product", sourcePath: "ui/src/components/HoverTimestamp.tsx", status: "covered", exampleKind: "direct" },
  { componentId: "RunTranscriptView", category: "workflow", sourcePath: "ui/src/components/transcript/RunTranscriptView.tsx", status: "fixture-backed", exampleKind: "module" },
  { componentId: "CommentThread", category: "workflow", sourcePath: "ui/src/components/CommentThread.tsx", status: "covered", exampleKind: "module" },
  { componentId: "MarkdownEditor", category: "workflow", sourcePath: "ui/src/components/MarkdownEditor.tsx", status: "covered", exampleKind: "module" },
  { componentId: "AgentConfigForm", category: "workflow", sourcePath: "ui/src/components/AgentConfigForm.tsx", status: "context-required", exampleKind: "registry-only", gaps: "Needs runtime adapter fixtures and org data." },
  { componentId: "NewIssueDialog", category: "workflow", sourcePath: "ui/src/components/NewIssueDialog.tsx", status: "context-required", exampleKind: "registry-only", gaps: "Uses dialog context, org data, labels, agents, and projects." },
  { componentId: "IssueProperties", category: "product", sourcePath: "ui/src/components/IssueProperties.tsx", status: "context-required", exampleKind: "registry-only", gaps: "Needs issue, agents, projects, goals, and mutation callbacks." },
  { componentId: "IssuesList", category: "workflow", sourcePath: "ui/src/components/IssuesList.tsx", status: "context-required", exampleKind: "registry-only", gaps: "Better verified with issue board E2E and data fixtures." },
  { componentId: "KanbanBoard", category: "workflow", sourcePath: "ui/src/components/KanbanBoard.tsx", status: "context-required", exampleKind: "registry-only", gaps: "Needs drag/drop workflow fixtures." },
  { componentId: "ThreeColumnContextSidebar", category: "shell", sourcePath: "ui/src/components/ThreeColumnContextSidebar.tsx", status: "context-required", exampleKind: "registry-only", gaps: "Route and organization context required." },
  { componentId: "PrimaryRail", category: "shell", sourcePath: "ui/src/components/PrimaryRail.tsx", status: "context-required", exampleKind: "registry-only", gaps: "App shell route state required." },
  { componentId: "Layout", category: "shell", sourcePath: "ui/src/components/Layout.tsx", status: "context-required", exampleKind: "registry-only", gaps: "Full app layout, not a standalone component." },
  { componentId: "sidebarItemStyles", category: "helper", sourcePath: "ui/src/components/sidebarItemStyles.ts", status: "not-renderable", exampleKind: "excluded", gaps: "Style helper, covered through shell components." },
  { componentId: "agent-config-defaults", category: "helper", sourcePath: "ui/src/components/agent-config-defaults.ts", status: "not-renderable", exampleKind: "excluded", gaps: "Pure defaults and tested separately." },
  { componentId: "semanticTones", category: "helper", sourcePath: "ui/src/components/ui/semanticTones.ts", status: "not-renderable", exampleKind: "excluded", gaps: "Token helper, visible through status and semantic components." },
];

export function getUiLabCoverage() {
  return uiLabCoverage;
}

const fixtureAgent: Agent = {
  id: "agent-design-lead",
  orgId: "org-rudder",
  name: "Design Lead",
  urlKey: "design-lead",
  role: "designer" as AgentRole,
  title: "UI Systems",
  icon: null,
  status: "active",
  reportsTo: null,
  capabilities: "Reviews product UI and keeps reusable components aligned.",
  agentRuntimeType: "process",
  agentRuntimeConfig: {},
  runtimeConfig: {},
  budgetMonthlyCents: 50000,
  spentMonthlyCents: 12400,
  pauseReason: null,
  pausedAt: null,
  permissions: { canCreateAgents: true },
  lastHeartbeatAt: new Date(Date.now() - 1000 * 60 * 12),
  metadata: null,
  createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 30),
  updatedAt: new Date(Date.now() - 1000 * 60 * 12),
};

const fixtureActivity: ActivityEvent = {
  id: "activity-ui-lab",
  orgId: "org-rudder",
  actorType: "agent",
  actorId: fixtureAgent.id,
  action: "issue.updated",
  entityType: "issue",
  entityId: "issue-ui-lab",
  agentId: fixtureAgent.id,
  runId: null,
  details: {
    title: "Build UI Lab",
    status: "in_review",
    _previous: { status: "in_progress" },
  },
  createdAt: new Date(Date.now() - 1000 * 60 * 8),
};

const fixtureIssue: Issue = {
  id: "issue-ui-lab",
  orgId: "org-rudder",
  projectId: null,
  projectWorkspaceId: null,
  goalId: null,
  parentId: null,
  title: "Build the internal UI Lab",
  description: "Expose common Rudder components in one reviewable surface.",
  status: "in_review",
  priority: "high",
  boardOrder: 1,
  assigneeAgentId: fixtureAgent.id,
  assigneeUserId: null,
  reviewerAgentId: null,
  reviewerUserId: "local-board",
  checkoutRunId: null,
  executionRunId: null,
  executionAgentNameKey: null,
  executionLockedAt: null,
  createdByAgentId: null,
  createdByUserId: "local-board",
  issueNumber: 214,
  identifier: "RUD-214",
  requestDepth: 0,
  billingCode: null,
  assigneeAgentRuntimeOverrides: null,
  executionWorkspaceId: null,
  executionWorkspacePreference: null,
  executionWorkspaceSettings: null,
  startedAt: new Date(Date.now() - 1000 * 60 * 60),
  completedAt: null,
  cancelledAt: null,
  hiddenAt: null,
  labelIds: ["label-ui"],
  labels: [{
    id: "label-ui",
    orgId: "org-rudder",
    name: "UI",
    color: "#0ea5e9",
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24),
    updatedAt: new Date(Date.now() - 1000 * 60 * 60),
  }],
  createdAt: new Date(Date.now() - 1000 * 60 * 60 * 2),
  updatedAt: new Date(Date.now() - 1000 * 60 * 8),
};

const fixtureApproval: Approval = {
  id: "approval-ui-lab",
  orgId: "org-rudder",
  type: "hire_agent",
  requestedByAgentId: fixtureAgent.id,
  requestedByUserId: null,
  status: "pending",
  payload: {
    name: "Reviewer Agent",
    role: "qa",
    title: "UI Reviewer",
    capabilities: "Reviews visible component and route changes before handoff.",
    agentRuntimeType: "codex_local",
    desiredSkills: ["agent-work-reviewer-maintainer", "rudder-ui-polish-maintainer"],
  },
  decisionNote: null,
  decidedByUserId: null,
  decidedAt: null,
  createdAt: new Date(Date.now() - 1000 * 60 * 30),
  updatedAt: new Date(Date.now() - 1000 * 60 * 10),
};

function LabPanel({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-md border border-border bg-card">
      <div className="border-b border-border px-4 py-3">
        <h3 className="text-sm font-semibold">{title}</h3>
        {description ? <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p> : null}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

function LabExample({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-border bg-background p-3">
      <div className="mb-3">
        <h4 className="text-sm font-medium">{title}</h4>
        {description ? <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </div>
  );
}

function StatusPill({ status }: { status: CoverageStatus }) {
  return (
    <span className={cn("inline-flex items-center rounded-sm border px-1.5 py-0.5 text-[11px] font-medium", statusClassNames[status])}>
      {statusLabels[status]}
    </span>
  );
}

function coverageCounts() {
  return uiLabCoverage.reduce((acc, item) => {
    acc[item.status] = (acc[item.status] ?? 0) + 1;
    return acc;
  }, {} as Partial<Record<CoverageStatus, number>>);
}

function OverviewSection({ onOpenCoverage }: { onOpenCoverage: () => void }) {
  const counts = coverageCounts();
  const renderedCount = (counts.covered ?? 0) + (counts["fixture-backed"] ?? 0);
  const pendingCount = (counts["context-required"] ?? 0) + (counts["missing-example"] ?? 0);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-3">
        <MetricCard icon={CheckCircle2} value={renderedCount} label="Visible examples" description="Direct or fixture-backed lab coverage" />
        <MetricCard icon={ShieldAlert} value={pendingCount} label="Tracked gaps" description="Context-bound or missing examples" />
        <MetricCard icon={Boxes} value={uiLabCoverage.length} label="Inventory rows" description="Primitives, product components, patterns, and exclusions" />
      </div>

      <LabPanel title="Inventory contract" description="The lab tracks renderable product surfaces, not every helper file. Context-bound components are listed honestly instead of faked.">
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-2 text-sm">
            <div className="flex items-center gap-2"><StatusPill status="covered" /> Rendered directly with local state.</div>
            <div className="flex items-center gap-2"><StatusPill status="fixture-backed" /> Rendered with stable fixtures.</div>
            <div className="flex items-center gap-2"><StatusPill status="context-required" /> Needs app or API context.</div>
          </div>
          <div className="space-y-2 text-sm">
            <div className="flex items-center gap-2"><StatusPill status="missing-example" /> In scope, needs a real sample.</div>
            <div className="flex items-center gap-2"><StatusPill status="not-renderable" /> Helper, type, or style module.</div>
            <div className="flex items-center gap-2"><StatusPill status="deprecated" /> Compatibility-only surface.</div>
          </div>
        </div>
        <Button className="mt-4" size="sm" variant="outline" onClick={onOpenCoverage}>
          <Search className="h-4 w-4" />
          Search coverage
        </Button>
      </LabPanel>

      <LabPanel title="Contributor workflow" description="Use this lab as the visual review surface for reusable UI work. Workflow E2E tests still own behavior correctness.">
        <ol className="grid gap-2 text-sm text-muted-foreground md:grid-cols-2">
          <li className="rounded-md border border-border bg-background p-3">1. Add or update a lab example for common primitives and reusable product components.</li>
          <li className="rounded-md border border-border bg-background p-3">2. Add a registry row for context-bound components instead of forcing a broken sample.</li>
          <li className="rounded-md border border-border bg-background p-3">3. Keep fixture-backed workflow examples sanitized and stable.</li>
          <li className="rounded-md border border-border bg-background p-3">4. Verify visible workflow changes in the browser before handoff.</li>
        </ol>
      </LabPanel>
    </div>
  );
}

function PrimitivesSection() {
  const [selectValue, setSelectValue] = useState("in_progress");
  const [enabled, setEnabled] = useState(true);

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <LabPanel title="Buttons and badges">
        <div className="flex flex-wrap items-center gap-2">
          <Button>Default</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="destructive">Delete</Button>
          <Badge>Default</Badge>
          <Badge variant="outline">Outline</Badge>
          <Badge variant="ghost">Ghost</Badge>
        </div>
      </LabPanel>

      <LabPanel title="Inputs">
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="ui-lab-name">Name</Label>
            <Input id="ui-lab-name" placeholder="Agent name" defaultValue="Design Lead" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ui-lab-select">Status</Label>
            <Select value={selectValue} onValueChange={setSelectValue}>
              <SelectTrigger id="ui-lab-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="todo">Todo</SelectItem>
                <SelectItem value="in_progress">In progress</SelectItem>
                <SelectItem value="in_review">In review</SelectItem>
                <SelectItem value="done">Done</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2 md:col-span-2">
            <Label htmlFor="ui-lab-note">Note</Label>
            <Textarea id="ui-lab-note" defaultValue="Fixture-backed component examples should stay compact and operational." />
          </div>
          <div className="flex items-center gap-2">
            <Checkbox id="ui-lab-checkbox" defaultChecked />
            <Label htmlFor="ui-lab-checkbox">Show advanced states</Label>
          </div>
          <div className="flex items-center gap-2">
            <ToggleSwitch checked={enabled} onClick={() => setEnabled((value) => !value)} aria-label="Toggle lab switch" />
            <span className="text-sm text-muted-foreground">{enabled ? "Enabled" : "Disabled"}</span>
          </div>
        </div>
      </LabPanel>

      <LabPanel title="Tabs, avatars, skeletons">
        <Tabs defaultValue="avatars">
          <TabsList>
            <TabsTrigger value="avatars">Avatars</TabsTrigger>
            <TabsTrigger value="loading">Loading</TabsTrigger>
          </TabsList>
          <TabsContent value="avatars" className="space-y-3 pt-3">
            <div className="flex items-center gap-3">
              <Avatar size="sm"><AvatarFallback>DL</AvatarFallback></Avatar>
              <Avatar><AvatarFallback>PM</AvatarFallback></Avatar>
              <Avatar size="lg"><AvatarFallback>QA</AvatarFallback></Avatar>
              <AvatarGroup>
                <Avatar><AvatarFallback>A</AvatarFallback></Avatar>
                <Avatar><AvatarFallback>B</AvatarFallback></Avatar>
                <AvatarGroupCount>+4</AvatarGroupCount>
              </AvatarGroup>
            </div>
          </TabsContent>
          <TabsContent value="loading" className="space-y-2 pt-3">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-20 w-full" />
          </TabsContent>
        </Tabs>
      </LabPanel>

      <LabPanel title="Separators and status tokens">
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            {["todo", "in_progress", "in_review", "done", "blocked", "cancelled"].map((status) => (
              <StatusBadge key={status} status={status} />
            ))}
          </div>
          <Separator />
          <div className="flex flex-wrap items-center gap-4">
            {["critical", "high", "medium", "low"].map((priority) => (
              <span key={priority} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <PriorityIcon priority={priority} />
                {priority}
              </span>
            ))}
          </div>
        </div>
      </LabPanel>
    </div>
  );
}

function CommonComponentsSection() {
  const [filters, setFilters] = useState<FilterValue[]>([
    { key: "status", label: "Status", value: "In review" },
    { key: "assignee", label: "Assignee", value: "Design Lead" },
  ]);
  const [inlineTitle, setInlineTitle] = useState("Inline editable title");
  const agentMap = useMemo(() => new Map([[fixtureAgent.id, fixtureAgent]]), []);
  const entityNameMap = useMemo(() => new Map([["issue:issue-ui-lab", "RUD-214"]]), []);
  const entityTitleMap = useMemo(() => new Map([["issue:issue-ui-lab", "Build UI Lab"]]), []);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 xl:grid-cols-2">
        <LabExample title="Status, priority, and rows">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <StatusIcon status="in_progress" />
              <StatusIcon status="in_review" />
              <StatusIcon status="done" />
              <PriorityIcon priority="critical" />
              <PriorityIcon priority="high" />
              <PriorityIcon priority="low" />
            </div>
            <div className="rounded-md border border-border">
              <EntityRow
                leading={<><StatusIcon status="in_progress" /><PriorityIcon priority="high" /></>}
                identifier="RUD-214"
                title="Build the internal UI Lab"
                subtitle="Fixture-backed component coverage"
                trailing={<StatusBadge status="in_review" />}
              />
              <EntityRow
                leading={<><StatusIcon status="todo" /><PriorityIcon priority="medium" /></>}
                identifier="RUD-215"
                title="Add component examples for context-bound forms"
                subtitle="Tracked as a coverage gap"
                trailing={<StatusBadge status="todo" />}
              />
            </div>
          </div>
        </LabExample>

        <LabExample title="Identity and assignees">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-5">
              <Identity name="Operator" size="sm" />
              <Identity name="Board Reviewer" />
              <AgentIdentity name="Design Lead" role="designer" />
            </div>
            <div className="grid gap-2">
              <AssigneeLabel kind="agent" label="Design Lead" badgeLabel="UI Systems" agentRole="designer" />
              <AssigneeLabel kind="user" label="Me" badgeLabel="Board" />
              <AssigneeLabel kind="unassigned" label="Unassigned" muted />
              <AgentMenuLabel agent={fixtureAgent} />
              <AssigneeSelfActionLabel />
            </div>
          </div>
        </LabExample>

        <LabExample title="Labels, filters, and inline editing">
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <IssueLabelChip label={{ name: "UI", color: "#0ea5e9" }} />
              <IssueLabelChip label={{ name: "Regression", color: "#f97316" }} size="sm" />
              <IssueLabelChip label={{ name: "Needs review", color: "#8b5cf6" }} />
            </div>
            <FilterBar
              filters={filters}
              onRemove={(key) => setFilters((current) => current.filter((filter) => filter.key !== key))}
              onClear={() => setFilters([])}
            />
            {filters.length === 0 ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setFilters([{ key: "status", label: "Status", value: "In review" }])}
              >
                Restore filters
              </Button>
            ) : null}
            <InlineEditor value={inlineTitle} onSave={setInlineTitle} as="h2" className="text-base font-semibold" />
          </div>
        </LabExample>

        <LabExample title="Activity, timestamps, copy, and progress">
          <div className="space-y-4">
            <div className="rounded-md border border-border">
              <ActivityRow
                event={fixtureActivity}
                agentMap={agentMap}
                entityNameMap={entityNameMap}
                entityTitleMap={entityTitleMap}
              />
            </div>
            <div className="group flex flex-wrap items-center gap-4 text-sm">
              <HoverTimestampLabel date={fixtureActivity.createdAt} label="8m ago" />
              <CopyText text="RUD-214" className="font-mono text-xs text-muted-foreground">RUD-214</CopyText>
              <TextDots text="Running checks" />
            </div>
            <QuotaBar label="Monthly token budget" percentUsed={68} leftLabel="$340" rightLabel="/ $500" />
          </div>
        </LabExample>

        <LabExample title="Issue rows and agent actions">
          <div className="space-y-3">
            <div className="rounded-md border border-border">
              <IssueRow
                issue={fixtureIssue}
                desktopTrailing={<StatusBadge status={fixtureIssue.status} />}
                trailingMeta="Updated 8m ago"
                unreadState="visible"
                onMarkRead={() => {}}
              />
              <IssueRow
                issue={{ ...fixtureIssue, id: "issue-ui-lab-2", identifier: "RUD-215", title: "Add command palette fixture coverage", status: "todo", priority: "medium" }}
                desktopTrailing={<StatusBadge status="todo" />}
                trailingMeta="Planned"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <RunButton onClick={() => {}} />
              <RunButton onClick={() => {}} disabled label="Running" />
              <PauseResumeButton isPaused={false} onPause={() => {}} onResume={() => {}} />
              <PauseResumeButton isPaused onPause={() => {}} onResume={() => {}} />
            </div>
          </div>
        </LabExample>

        <LabExample title="Approval card">
          <ApprovalCard
            approval={fixtureApproval}
            requesterAgent={fixtureAgent}
            onApprove={() => {}}
            onReject={() => {}}
            onRequestRevision={() => {}}
            onOpen={() => {}}
            isPending={false}
            supportingText="Approval surfaces combine request context, payload review, and decision actions."
          />
        </LabExample>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <LabPanel title="Metric cards">
          <div className="grid gap-3 sm:grid-cols-2">
            <MetricCard icon={Bot} value={12} label="Active agents" description="Agents currently available for work" />
            <MetricCard icon={ListTodo} value={48} label="Open issues" description="Across active projects" />
            <MetricCard icon={DollarSign} value="$1,234" label="Monthly spend" description="Under current budget" />
            <MetricCard icon={Gauge} value="92%" label="Loop health" description="Runs with close-out signal" />
          </div>
        </LabPanel>

        <LabPanel title="Empty and loading states">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-md border border-border">
              <EmptyState icon={Inbox} message="No pending approvals." action="Create issue" onAction={() => {}} />
            </div>
            <div className="rounded-md border border-border p-4">
              <PageSkeleton variant="list" />
            </div>
          </div>
        </LabPanel>
      </div>
    </div>
  );
}

function CoverageSection() {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<CoverageStatus | "all">("all");
  const [categoryFilter, setCategoryFilter] = useState<CoverageCategory | "all">("all");

  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return uiLabCoverage.filter((item) => {
      const matchesQuery = !normalizedQuery
        || item.componentId.toLowerCase().includes(normalizedQuery)
        || item.sourcePath.toLowerCase().includes(normalizedQuery)
        || item.category.toLowerCase().includes(normalizedQuery)
        || item.status.toLowerCase().includes(normalizedQuery);
      return matchesQuery
        && (statusFilter === "all" || item.status === statusFilter)
        && (categoryFilter === "all" || item.category === categoryFilter);
    });
  }, [categoryFilter, query, statusFilter]);

  return (
    <div className="space-y-4">
      <LabPanel title="Coverage filters" description="Search by component name, path, category, or status. Context-bound rows are deliberately visible so gaps do not disappear.">
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_180px_180px]">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search components, paths, or statuses"
              className="pl-8"
            />
          </div>
          <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as CoverageStatus | "all")}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {Object.keys(statusLabels).map((status) => (
                <SelectItem key={status} value={status}>{statusLabels[status as CoverageStatus]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={categoryFilter} onValueChange={(value) => setCategoryFilter(value as CoverageCategory | "all")}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              {["primitive", "product", "pattern", "workflow", "shell", "helper"].map((category) => (
                <SelectItem key={category} value={category}>{category}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </LabPanel>

      <div className="overflow-hidden rounded-md border border-border">
        <table className="w-full text-left text-xs">
          <thead className="border-b border-border bg-muted/40 text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Component</th>
              <th className="px-3 py-2 font-medium">Category</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="hidden px-3 py-2 font-medium lg:table-cell">Source</th>
              <th className="hidden px-3 py-2 font-medium xl:table-cell">Gaps</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {filtered.map((item) => (
              <tr key={item.componentId} className="bg-background align-top">
                <td className="px-3 py-2 font-medium">{item.componentId}</td>
                <td className="px-3 py-2 text-muted-foreground">{item.category}</td>
                <td className="px-3 py-2"><StatusPill status={item.status} /></td>
                <td className="hidden px-3 py-2 font-mono text-[11px] text-muted-foreground lg:table-cell">{item.sourcePath}</td>
                <td className="hidden max-w-md px-3 py-2 text-muted-foreground xl:table-cell">{item.gaps ?? item.exampleKind}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 ? (
          <div className="border-t border-border bg-background px-4 py-8 text-center text-sm text-muted-foreground">
            No coverage rows match the current filters.
          </div>
        ) : null}
      </div>
    </div>
  );
}

function SectionBody({
  section,
  onOpenCoverage,
}: {
  section: UiLabSectionId;
  onOpenCoverage: () => void;
}) {
  if (section === "overview") return <OverviewSection onOpenCoverage={onOpenCoverage} />;
  if (section === "primitives") return <PrimitivesSection />;
  if (section === "common") return <CommonComponentsSection />;
  if (section === "design-guide") {
    return (
      <LabPanel title="Existing design guide" description="Preserved from the previous /design-guide route while the lab is split into modules.">
        <DesignGuide />
      </LabPanel>
    );
  }
  if (section === "transcripts") {
    return (
      <LabPanel title="Run transcript UX lab" description="Existing fixture-backed transcript lab, reachable from the unified UI Lab.">
        <RunTranscriptUxLab />
      </LabPanel>
    );
  }
  return <CoverageSection />;
}

export function UiLab({ initialSection = "overview" }: { initialSection?: UiLabSectionId }) {
  const [activeSection, setActiveSection] = useState<UiLabSectionId>(initialSection);
  const selected = sectionOptions.find((section) => section.id === activeSection) ?? sectionOptions[0]!;
  const SelectedIcon = selected.icon;

  useEffect(() => {
    setActiveSection(initialSection);
  }, [initialSection]);

  return (
    <div className="min-h-full">
      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="inline-flex items-center gap-2 rounded-sm border border-border bg-muted/40 px-2 py-1 text-[11px] font-medium text-muted-foreground">
            <FlaskConical className="h-3.5 w-3.5" />
            Internal UI Lab
          </div>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight">UI Lab</h1>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">
            Component inventory, fixture-backed product examples, and workflow previews rendered inside the real Rudder app shell.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge variant="outline">{uiLabCoverage.length} inventory rows</Badge>
          <Badge variant="outline">/ui-lab</Badge>
          <Badge variant="ghost">/design-guide compatible</Badge>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="rounded-md border border-border bg-card p-2 xl:sticky xl:top-4 xl:self-start">
          <nav className="space-y-1">
            {sectionOptions.map((section) => {
              const Icon = section.icon;
              const selectedSection = activeSection === section.id;
              return (
                <button
                  key={section.id}
                  type="button"
                  onClick={() => setActiveSection(section.id)}
                  className={cn(
                    "flex w-full items-start gap-2 rounded-md px-3 py-2 text-left transition-colors",
                    selectedSection
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                  )}
                >
                  <Icon className="mt-0.5 h-4 w-4 shrink-0" />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{section.label}</span>
                    <span className="mt-0.5 block text-xs leading-4 opacity-80">{section.description}</span>
                  </span>
                </button>
              );
            })}
          </nav>
        </aside>

        <main className="min-w-0 space-y-4">
          <div className="rounded-md border border-border bg-card px-4 py-3">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 rounded-sm border border-border bg-background p-1.5 text-muted-foreground">
                <SelectedIcon className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <h2 className="text-base font-semibold">{selected.label}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{selected.description}</p>
              </div>
            </div>
          </div>
          <SectionBody section={activeSection} onOpenCoverage={() => setActiveSection("coverage")} />
        </main>
      </div>
    </div>
  );
}
