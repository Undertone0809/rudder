import { ChartCard, IssueStatusChart, PriorityChart } from "@/components/ActivityCharts";
import { ActivityRow } from "@/components/ActivityRow";
import { PauseResumeButton, RunButton } from "@/components/AgentActionButtons";
import { AgentIdentity } from "@/components/AgentAvatar";
import { AgentIcon, AgentIconPicker } from "@/components/AgentIconPicker";
import { AgentProperties } from "@/components/AgentProperties";
import { ApprovalCard } from "@/components/ApprovalCard";
import { ApprovalPayloadRenderer } from "@/components/ApprovalPayload";
import { AgentMenuLabel, AssigneeLabel, AssigneeSelfActionLabel } from "@/components/AssigneeLabel";
import { BudgetIncidentCard } from "@/components/BudgetIncidentCard";
import { BudgetPolicyCard } from "@/components/BudgetPolicyCard";
import { CopyText } from "@/components/CopyText";
import { DashboardDateRangeControl, type DashboardDatePreset } from "@/components/DashboardDateRangeControl";
import { EmptyState } from "@/components/EmptyState";
import { EntityRow } from "@/components/EntityRow";
import { FilterBar, type FilterValue } from "@/components/FilterBar";
import { FinanceKindCard } from "@/components/FinanceKindCard";
import { FinanceTimelineCard } from "@/components/FinanceTimelineCard";
import { GoalProperties } from "@/components/GoalProperties";
import { GoalTree } from "@/components/GoalTree";
import { HeartbeatEnabledButtons } from "@/components/HeartbeatEnabledButtons";
import { HoverTimestampLabel } from "@/components/HoverTimestamp";
import { Identity } from "@/components/Identity";
import { InlineEditor } from "@/components/InlineEditor";
import { InlineEntitySelector } from "@/components/InlineEntitySelector";
import { IssueLabelChip } from "@/components/IssueLabelChip";
import { IssueRow } from "@/components/IssueRow";
import { JsonSchemaForm, type JsonSchemaNode } from "@/components/JsonSchemaForm";
import { MarkdownBody } from "@/components/MarkdownBody";
import { MetricCard } from "@/components/MetricCard";
import { PackageFileTree, type FileTreeNode } from "@/components/PackageFileTree";
import { PageSkeleton } from "@/components/PageSkeleton";
import { PageTabBar } from "@/components/PageTabBar";
import { PriorityIcon } from "@/components/PriorityIcon";
import { ProjectProperties } from "@/components/ProjectProperties";
import { QuotaBar } from "@/components/QuotaBar";
import { ReportsToPicker } from "@/components/ReportsToPicker";
import { ResourceLocatorField } from "@/components/ResourceLocatorField";
import { RudderLogo } from "@/components/RudderLogo";
import { ScheduleEditor } from "@/components/ScheduleEditor";
import { SidebarNavItem } from "@/components/SidebarNavItem";
import { SidebarSection } from "@/components/SidebarSection";
import { SidebarSectionActionButton, SidebarSectionHeader } from "@/components/SidebarSectionHeader";
import { SkillReferenceToken } from "@/components/SkillReferenceToken";
import { StatusBadge } from "@/components/StatusBadge";
import { StatusIcon } from "@/components/StatusIcon";
import { TextDots } from "@/components/TextDots";
import { ChatRichReferences } from "@/components/chat-renderables/ChatRichReferences";
import { Avatar, AvatarFallback, AvatarGroup, AvatarGroupCount } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { runTranscriptFixtureEntries } from "@/fixtures/runTranscriptFixtures";
import { cn } from "@/lib/utils";
import type {
  ActivityEvent,
  Agent,
  AgentRole,
  Approval,
  BudgetIncident,
  BudgetPolicySummary,
  ChatAskUserRequest,
  ChatConversation,
  ChatMessage,
  FinanceByKind,
  FinanceEvent,
  Goal,
  Issue,
  Project,
} from "@rudderhq/shared";
import type { LucideIcon } from "lucide-react";
import {
  Bot,
  Boxes,
  CheckCircle2,
  ChevronDown,
  Component,
  DollarSign,
  FileText,
  FlaskConical,
  Folder,
  Gauge,
  Inbox,
  LayoutDashboard,
  ListFilter,
  ListTodo,
  Paperclip,
  Search,
  Send,
  Shapes,
  ShieldAlert,
  Sparkles,
  Square,
  Workflow,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  AskUserAnswerBubble,
  AskUserHistoryRecord,
  AskUserPanel,
  AssistantDraftItem,
  ChatAssistantAttributionRow,
  ChatAttachmentList,
  ChatAttachmentPreviewDialog,
  ChatEmptyStatePromptOptions,
  ChatFileAttachmentChip,
  ChatImageAttachmentTile,
  ChatLongMessageBody,
  ChatMessageItem,
  ChatMessagesLoadingState,
  ChatSystemMessageBody,
  EMPTY_STATE_PROMPT_GROUPS,
  OptimisticUserDraftItem,
  PendingAttachmentPreview,
  StreamTranscriptItem,
  type AttachmentPreviewState,
} from "./Chat.parts";
import { DesignGuide } from "./DesignGuide";
import { RunTranscriptUxLab } from "./RunTranscriptUxLab";

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
  { componentId: "ActivityCharts", category: "product", sourcePath: "ui/src/components/ActivityCharts.tsx", status: "fixture-backed", exampleKind: "fixture" },
  { componentId: "FilterBar", category: "product", sourcePath: "ui/src/components/FilterBar.tsx", status: "covered", exampleKind: "direct" },
  { componentId: "InlineEditor", category: "product", sourcePath: "ui/src/components/InlineEditor.tsx", status: "covered", exampleKind: "direct" },
  { componentId: "InlineEntitySelector", category: "product", sourcePath: "ui/src/components/InlineEntitySelector.tsx", status: "covered", exampleKind: "direct" },
  { componentId: "PageSkeleton", category: "product", sourcePath: "ui/src/components/PageSkeleton.tsx", status: "covered", exampleKind: "direct" },
  { componentId: "Identity", category: "product", sourcePath: "ui/src/components/Identity.tsx", status: "covered", exampleKind: "direct" },
  { componentId: "AgentIdentity", category: "product", sourcePath: "ui/src/components/AgentAvatar.tsx", status: "covered", exampleKind: "direct" },
  { componentId: "AgentAvatar", category: "product", sourcePath: "ui/src/components/AgentAvatar.tsx", status: "covered", exampleKind: "direct" },
  { componentId: "AssigneeLabel", category: "product", sourcePath: "ui/src/components/AssigneeLabel.tsx", status: "covered", exampleKind: "direct" },
  { componentId: "ReportsToPicker", category: "product", sourcePath: "ui/src/components/ReportsToPicker.tsx", status: "covered", exampleKind: "direct" },
  { componentId: "IssueLabelChip", category: "product", sourcePath: "ui/src/components/IssueLabelChip.tsx", status: "covered", exampleKind: "direct" },
  { componentId: "ActivityRow", category: "product", sourcePath: "ui/src/components/ActivityRow.tsx", status: "fixture-backed", exampleKind: "fixture" },
  { componentId: "IssueRow", category: "product", sourcePath: "ui/src/components/IssueRow.tsx", status: "fixture-backed", exampleKind: "fixture" },
  { componentId: "ApprovalCard", category: "product", sourcePath: "ui/src/components/ApprovalCard.tsx", status: "fixture-backed", exampleKind: "fixture" },
  { componentId: "AgentActionButtons", category: "product", sourcePath: "ui/src/components/AgentActionButtons.tsx", status: "covered", exampleKind: "direct" },
  { componentId: "AgentIconPicker", category: "product", sourcePath: "ui/src/components/AgentIconPicker.tsx", status: "covered", exampleKind: "direct" },
  { componentId: "AgentProperties", category: "product", sourcePath: "ui/src/components/AgentProperties.tsx", status: "fixture-backed", exampleKind: "fixture" },
  { componentId: "ApprovalPayload", category: "product", sourcePath: "ui/src/components/ApprovalPayload.tsx", status: "fixture-backed", exampleKind: "fixture" },
  { componentId: "ApprovalPayloadRenderer", category: "product", sourcePath: "ui/src/components/ApprovalPayload.tsx", status: "fixture-backed", exampleKind: "fixture" },
  { componentId: "DashboardDateRangeControl", category: "product", sourcePath: "ui/src/components/DashboardDateRangeControl.tsx", status: "covered", exampleKind: "direct" },
  { componentId: "GoalTree", category: "product", sourcePath: "ui/src/components/GoalTree.tsx", status: "fixture-backed", exampleKind: "fixture" },
  { componentId: "HeartbeatEnabledButtons", category: "product", sourcePath: "ui/src/components/HeartbeatEnabledButtons.tsx", status: "covered", exampleKind: "direct" },
  { componentId: "JsonSchemaForm", category: "product", sourcePath: "ui/src/components/JsonSchemaForm.tsx", status: "fixture-backed", exampleKind: "fixture" },
  { componentId: "MarkdownBody", category: "product", sourcePath: "ui/src/components/MarkdownBody.tsx", status: "fixture-backed", exampleKind: "fixture" },
  { componentId: "PackageFileTree", category: "product", sourcePath: "ui/src/components/PackageFileTree.tsx", status: "fixture-backed", exampleKind: "fixture" },
  { componentId: "PageTabBar", category: "product", sourcePath: "ui/src/components/PageTabBar.tsx", status: "covered", exampleKind: "direct" },
  { componentId: "GoalProperties", category: "product", sourcePath: "ui/src/components/GoalProperties.tsx", status: "fixture-backed", exampleKind: "fixture" },
  { componentId: "ProjectProperties", category: "product", sourcePath: "ui/src/components/ProjectProperties.tsx", status: "fixture-backed", exampleKind: "fixture" },
  { componentId: "ResourceLocatorField", category: "product", sourcePath: "ui/src/components/ResourceLocatorField.tsx", status: "covered", exampleKind: "direct" },
  { componentId: "ScheduleEditor", category: "product", sourcePath: "ui/src/components/ScheduleEditor.tsx", status: "covered", exampleKind: "direct" },
  { componentId: "BudgetPolicyCard", category: "product", sourcePath: "ui/src/components/BudgetPolicyCard.tsx", status: "fixture-backed", exampleKind: "fixture" },
  { componentId: "BudgetIncidentCard", category: "product", sourcePath: "ui/src/components/BudgetIncidentCard.tsx", status: "fixture-backed", exampleKind: "fixture" },
  { componentId: "FinanceKindCard", category: "product", sourcePath: "ui/src/components/FinanceKindCard.tsx", status: "fixture-backed", exampleKind: "fixture" },
  { componentId: "FinanceTimelineCard", category: "product", sourcePath: "ui/src/components/FinanceTimelineCard.tsx", status: "fixture-backed", exampleKind: "fixture" },
  { componentId: "RudderLogo", category: "product", sourcePath: "ui/src/components/RudderLogo.tsx", status: "covered", exampleKind: "direct" },
  { componentId: "SkillReferenceToken", category: "product", sourcePath: "ui/src/components/SkillReferenceToken.tsx", status: "covered", exampleKind: "direct" },
  { componentId: "SidebarNavItem", category: "shell", sourcePath: "ui/src/components/SidebarNavItem.tsx", status: "covered", exampleKind: "direct" },
  { componentId: "SidebarSection", category: "shell", sourcePath: "ui/src/components/SidebarSection.tsx", status: "covered", exampleKind: "direct" },
  { componentId: "SidebarSectionHeader", category: "shell", sourcePath: "ui/src/components/SidebarSectionHeader.tsx", status: "covered", exampleKind: "direct" },
  { componentId: "SidebarSectionActionButton", category: "shell", sourcePath: "ui/src/components/SidebarSectionHeader.tsx", status: "covered", exampleKind: "direct" },
  { componentId: "CommandPalette", category: "shell", sourcePath: "ui/src/components/CommandPalette.tsx", status: "context-required", exampleKind: "registry-only", gaps: "Global app command surface; opened through app shell keyboard/event context." },
  { componentId: "AccountingModelCard", category: "product", sourcePath: "ui/src/components/AccountingModelCard.tsx", status: "context-required", exampleKind: "registry-only", gaps: "Finance settings card with product copy; best reviewed in billing/settings context." },
  { componentId: "AgentActionsMenu", category: "product", sourcePath: "ui/src/components/AgentActionsMenu.tsx", status: "context-required", exampleKind: "registry-only", gaps: "Uses query mutations, toast, dialog, and router side effects." },
  { componentId: "ActiveAgentsPanel", category: "workflow", sourcePath: "ui/src/components/ActiveAgentsPanel.tsx", status: "context-required", exampleKind: "registry-only", gaps: "Polls live agents and heartbeat state from the API." },
  { componentId: "AppErrorBoundary", category: "shell", sourcePath: "ui/src/components/AppErrorBoundary.tsx", status: "context-required", exampleKind: "registry-only", gaps: "Requires a thrown route/render error to show fallback behavior." },
  { componentId: "ApprovalDetailDialog", category: "workflow", sourcePath: "ui/src/components/ApprovalDetailDialog.tsx", status: "context-required", exampleKind: "registry-only", gaps: "Dialog state and approval mutation flow are route-owned." },
  { componentId: "AsciiArtAnimation", category: "product", sourcePath: "ui/src/components/AsciiArtAnimation.tsx", status: "context-required", exampleKind: "registry-only", gaps: "Decorative onboarding/empty-state animation, better reviewed on its owning surface." },
  { componentId: "BillerSpendCard", category: "product", sourcePath: "ui/src/components/BillerSpendCard.tsx", status: "context-required", exampleKind: "registry-only", gaps: "Large finance aggregate card; coverage tracked with finance workflow fixtures." },
  { componentId: "FinanceBillerCard", category: "product", sourcePath: "ui/src/components/FinanceBillerCard.tsx", status: "context-required", exampleKind: "registry-only", gaps: "Finance aggregate card; best reviewed with billing dashboard data." },
  { componentId: "BudgetSidebarMarker", category: "shell", sourcePath: "ui/src/components/BudgetSidebarMarker.tsx", status: "context-required", exampleKind: "registry-only", gaps: "Sidebar budget marker depends on sidebar placement and live budget summary." },
  { componentId: "ClaudeSubscriptionPanel", category: "product", sourcePath: "ui/src/components/ClaudeSubscriptionPanel.tsx", status: "context-required", exampleKind: "registry-only", gaps: "Provider quota panel rendered through ProviderQuotaCard with live quota windows." },
  { componentId: "CodexSubscriptionPanel", category: "product", sourcePath: "ui/src/components/CodexSubscriptionPanel.tsx", status: "context-required", exampleKind: "registry-only", gaps: "Provider quota panel rendered through ProviderQuotaCard with live quota windows." },
  { componentId: "CopyText", category: "product", sourcePath: "ui/src/components/CopyText.tsx", status: "covered", exampleKind: "direct" },
  { componentId: "TextDots", category: "product", sourcePath: "ui/src/components/TextDots.tsx", status: "covered", exampleKind: "direct" },
  { componentId: "QuotaBar", category: "product", sourcePath: "ui/src/components/QuotaBar.tsx", status: "covered", exampleKind: "direct" },
  { componentId: "HoverTimestamp", category: "product", sourcePath: "ui/src/components/HoverTimestamp.tsx", status: "covered", exampleKind: "direct" },
  { componentId: "HoverTimestampLabel", category: "product", sourcePath: "ui/src/components/HoverTimestamp.tsx", status: "covered", exampleKind: "direct" },
  { componentId: "BreadcrumbBar", category: "shell", sourcePath: "ui/src/components/BreadcrumbBar.tsx", status: "context-required", exampleKind: "registry-only", gaps: "Global shell header wired to breadcrumbs, plugins, search, and organization route state." },
  { componentId: "DesktopUpdateStatusCard", category: "shell", sourcePath: "ui/src/components/DesktopUpdateStatusCard.tsx", status: "context-required", exampleKind: "registry-only", gaps: "Driven by desktop update progress provider state." },
  { componentId: "DevRestartBanner", category: "shell", sourcePath: "ui/src/components/DevRestartBanner.tsx", status: "context-required", exampleKind: "registry-only", gaps: "Toast-only side effect from live dev server health." },
  { componentId: "ImagePreviewDialog", category: "product", sourcePath: "ui/src/components/ImagePreviewDialog.tsx", status: "context-required", exampleKind: "registry-only", gaps: "Dialog preview state is owned by message/image surfaces." },
  { componentId: "InspectableImage", category: "product", sourcePath: "ui/src/components/InspectableImage.tsx", status: "context-required", exampleKind: "registry-only", gaps: "Useful behavior is context-menu and preview integration, covered through image workflows." },
  { componentId: "InstanceSidebar", category: "shell", sourcePath: "ui/src/components/InstanceSidebar.tsx", status: "context-required", exampleKind: "registry-only", gaps: "Instance navigation depends on shell route and instance context." },
  { componentId: "IssueDetailFind", category: "workflow", sourcePath: "ui/src/components/IssueDetailFind.tsx", status: "context-required", exampleKind: "registry-only", gaps: "Requires a scrollable issue detail document root to search and highlight." },
  { componentId: "LinearIssueSourceBoard", category: "workflow", sourcePath: "ui/src/components/LinearIssueSourceBoard.tsx", status: "context-required", exampleKind: "registry-only", gaps: "Linear source sync board depends on plugin/API-backed issue-source data." },
  { componentId: "LiveRunWidget", category: "workflow", sourcePath: "ui/src/components/LiveRunWidget.tsx", status: "context-required", exampleKind: "registry-only", gaps: "Polls live run state for an issue." },
  { componentId: "OnboardingWizard", category: "workflow", sourcePath: "ui/src/components/OnboardingWizard.tsx", status: "context-required", exampleKind: "registry-only", gaps: "Full onboarding workflow owns multi-step state and environment checks." },
  { componentId: "OpenCodeLogoIcon", category: "product", sourcePath: "ui/src/components/OpenCodeLogoIcon.tsx", status: "context-required", exampleKind: "registry-only", gaps: "Provider logo icon; visible through runtime/provider surfaces." },
  { componentId: "OrganizationPatternIcon", category: "product", sourcePath: "ui/src/components/OrganizationPatternIcon.tsx", status: "context-required", exampleKind: "registry-only", gaps: "Pattern icon family is chosen by organization shell/context." },
  { componentId: "OrganizationSettingsSidebar", category: "shell", sourcePath: "ui/src/components/OrganizationSettingsSidebar.tsx", status: "context-required", exampleKind: "registry-only", gaps: "Settings shell route state required." },
  { componentId: "PathInstructionsModal", category: "workflow", sourcePath: "ui/src/components/PathInstructionsModal.tsx", status: "context-required", exampleKind: "registry-only", gaps: "Modal should be reviewed with the path-picker workflow that opens it." },
  { componentId: "ProductTourOverlay", category: "workflow", sourcePath: "ui/src/components/ProductTourOverlay.tsx", status: "context-required", exampleKind: "registry-only", gaps: "Needs real target rectangles and route state." },
  { componentId: "ProjectResourcesPanel", category: "workflow", sourcePath: "ui/src/components/ProjectResourcesPanel.tsx", status: "context-required", exampleKind: "registry-only", gaps: "Project resources are API-backed and mutation-heavy." },
  { componentId: "PropertiesPanel", category: "shell", sourcePath: "ui/src/components/PropertiesPanel.tsx", status: "context-required", exampleKind: "registry-only", gaps: "Consumes global panel context rather than standalone props." },
  { componentId: "ProviderQuotaCard", category: "product", sourcePath: "ui/src/components/ProviderQuotaCard.tsx", status: "context-required", exampleKind: "registry-only", gaps: "Large provider aggregate card with quota-window variants; covered in finance workflows." },
  { componentId: "ScrollToBottom", category: "product", sourcePath: "ui/src/components/ScrollToBottom.tsx", status: "context-required", exampleKind: "registry-only", gaps: "Only meaningful inside a scroll container with live overflow state." },
  { componentId: "ToastViewport", category: "shell", sourcePath: "ui/src/components/ToastViewport.tsx", status: "context-required", exampleKind: "registry-only", gaps: "Global toast viewport and queued toast state." },
  { componentId: "WorktreeBanner", category: "shell", sourcePath: "ui/src/components/WorktreeBanner.tsx", status: "context-required", exampleKind: "registry-only", gaps: "Reads environment-derived worktree metadata." },
  { componentId: "RunTranscriptView", category: "workflow", sourcePath: "ui/src/components/transcript/RunTranscriptView.tsx", status: "fixture-backed", exampleKind: "module" },
  { componentId: "CommentThread", category: "workflow", sourcePath: "ui/src/components/CommentThread.tsx", status: "covered", exampleKind: "module" },
  { componentId: "MarkdownEditor", category: "workflow", sourcePath: "ui/src/components/MarkdownEditor.tsx", status: "covered", exampleKind: "module" },
  { componentId: "ChatEmptyStatePromptOptions", category: "workflow", sourcePath: "ui/src/pages/Chat.parts.tsx", status: "fixture-backed", exampleKind: "fixture" },
  { componentId: "ChatImageAttachmentTile", category: "workflow", sourcePath: "ui/src/pages/Chat.attachments.tsx", status: "fixture-backed", exampleKind: "fixture" },
  { componentId: "ChatFileAttachmentChip", category: "workflow", sourcePath: "ui/src/pages/Chat.attachments.tsx", status: "fixture-backed", exampleKind: "fixture" },
  { componentId: "PendingAttachmentPreview", category: "workflow", sourcePath: "ui/src/pages/Chat.attachments.tsx", status: "fixture-backed", exampleKind: "fixture" },
  { componentId: "ChatAttachmentList", category: "workflow", sourcePath: "ui/src/pages/Chat.attachments.tsx", status: "fixture-backed", exampleKind: "fixture" },
  { componentId: "ChatAttachmentPreviewDialog", category: "workflow", sourcePath: "ui/src/pages/Chat.attachments.tsx", status: "fixture-backed", exampleKind: "fixture" },
  { componentId: "ChatAssistantAttributionRow", category: "workflow", sourcePath: "ui/src/pages/Chat.messages.tsx", status: "fixture-backed", exampleKind: "fixture" },
  { componentId: "ProposalCard", category: "workflow", sourcePath: "ui/src/pages/Chat.messages.tsx", status: "fixture-backed", exampleKind: "fixture" },
  { componentId: "ChatLongMessageBody", category: "workflow", sourcePath: "ui/src/pages/Chat.messages.tsx", status: "fixture-backed", exampleKind: "fixture" },
  { componentId: "ChatSystemMessageBody", category: "workflow", sourcePath: "ui/src/pages/Chat.messages.tsx", status: "fixture-backed", exampleKind: "fixture" },
  { componentId: "AskUserHistoryRecord", category: "workflow", sourcePath: "ui/src/pages/Chat.messages.tsx", status: "fixture-backed", exampleKind: "fixture" },
  { componentId: "AskUserAnswerBubble", category: "workflow", sourcePath: "ui/src/pages/Chat.messages.tsx", status: "fixture-backed", exampleKind: "fixture" },
  { componentId: "AskUserPanel", category: "workflow", sourcePath: "ui/src/pages/Chat.messages.tsx", status: "fixture-backed", exampleKind: "fixture" },
  { componentId: "ChatMessageItem", category: "workflow", sourcePath: "ui/src/pages/Chat.messages.tsx", status: "fixture-backed", exampleKind: "fixture" },
  { componentId: "OptimisticUserDraftItem", category: "workflow", sourcePath: "ui/src/pages/Chat.messages.tsx", status: "fixture-backed", exampleKind: "fixture" },
  { componentId: "ChatMessagesLoadingState", category: "workflow", sourcePath: "ui/src/pages/Chat.messages.tsx", status: "fixture-backed", exampleKind: "fixture" },
  { componentId: "StreamTranscriptItem", category: "workflow", sourcePath: "ui/src/pages/Chat.messages.tsx", status: "fixture-backed", exampleKind: "fixture" },
  { componentId: "AssistantDraftItem", category: "workflow", sourcePath: "ui/src/pages/Chat.messages.tsx", status: "fixture-backed", exampleKind: "fixture" },
  { componentId: "ChatRichReferences", category: "workflow", sourcePath: "ui/src/components/chat-renderables/ChatRichReferences.tsx", status: "fixture-backed", exampleKind: "fixture" },
  { componentId: "ChatComposerSurface", category: "workflow", sourcePath: "ui/src/pages/Chat.tsx", status: "fixture-backed", exampleKind: "fixture" },
  { componentId: "ChatPage", category: "workflow", sourcePath: "ui/src/pages/Chat.tsx", status: "context-required", exampleKind: "registry-only", gaps: "Full chat route owns URL state, API queries, live generation, sidebar, and composer persistence." },
  { componentId: "AgentConfigForm", category: "workflow", sourcePath: "ui/src/components/AgentConfigForm.tsx", status: "context-required", exampleKind: "registry-only", gaps: "Needs runtime adapter fixtures and org data." },
  { componentId: "NewIssueDialog", category: "workflow", sourcePath: "ui/src/components/NewIssueDialog.tsx", status: "context-required", exampleKind: "registry-only", gaps: "Uses dialog context, org data, labels, agents, and projects." },
  { componentId: "IssueProperties", category: "product", sourcePath: "ui/src/components/IssueProperties.tsx", status: "context-required", exampleKind: "registry-only", gaps: "Needs issue, agents, projects, goals, and mutation callbacks." },
  { componentId: "IssuesList", category: "workflow", sourcePath: "ui/src/components/IssuesList.tsx", status: "context-required", exampleKind: "registry-only", gaps: "Better verified with issue board E2E and data fixtures." },
  { componentId: "KanbanBoard", category: "workflow", sourcePath: "ui/src/components/KanbanBoard.tsx", status: "context-required", exampleKind: "registry-only", gaps: "Needs drag/drop workflow fixtures." },
  { componentId: "ThreeColumnContextSidebar", category: "shell", sourcePath: "ui/src/components/ThreeColumnContextSidebar.tsx", status: "context-required", exampleKind: "registry-only", gaps: "Route and organization context required." },
  { componentId: "MessengerContextSidebar", category: "shell", sourcePath: "ui/src/components/MessengerContextSidebar.tsx", status: "context-required", exampleKind: "registry-only", gaps: "Messenger route state and thread data required." },
  { componentId: "PrimaryRail", category: "shell", sourcePath: "ui/src/components/PrimaryRail.tsx", status: "context-required", exampleKind: "registry-only", gaps: "App shell route state required." },
  { componentId: "Layout", category: "shell", sourcePath: "ui/src/components/Layout.tsx", status: "context-required", exampleKind: "registry-only", gaps: "Full app layout, not a standalone component." },
  { componentId: "MobileBottomNav", category: "shell", sourcePath: "ui/src/components/MobileBottomNav.tsx", status: "context-required", exampleKind: "registry-only", gaps: "Mobile shell route state required." },
  { componentId: "MobileWorkspaceDrawer", category: "shell", sourcePath: "ui/src/components/MobileWorkspaceDrawer.tsx", status: "context-required", exampleKind: "registry-only", gaps: "Mobile shell workspace state required." },
  { componentId: "OrganizationSwitcher", category: "shell", sourcePath: "ui/src/components/OrganizationSwitcher.tsx", status: "context-required", exampleKind: "registry-only", gaps: "Organization context and API data required." },
  { componentId: "SettingsSidebar", category: "shell", sourcePath: "ui/src/components/SettingsSidebar.tsx", status: "context-required", exampleKind: "registry-only", gaps: "Settings route state required." },
  { componentId: "SidebarAgents", category: "shell", sourcePath: "ui/src/components/SidebarAgents.tsx", status: "context-required", exampleKind: "registry-only", gaps: "Sidebar data and organization route state required." },
  { componentId: "SidebarChatSessions", category: "shell", sourcePath: "ui/src/components/SidebarChatSessions.tsx", status: "context-required", exampleKind: "registry-only", gaps: "Messenger/chat session API data and route state required." },
  { componentId: "SidebarProjects", category: "shell", sourcePath: "ui/src/components/SidebarProjects.tsx", status: "context-required", exampleKind: "registry-only", gaps: "Sidebar data and organization route state required." },
  { componentId: "NewAgentDialog", category: "workflow", sourcePath: "ui/src/components/NewAgentDialog.tsx", status: "context-required", exampleKind: "registry-only", gaps: "Dialog provider, org data, and mutation callbacks required." },
  { componentId: "NewGoalDialog", category: "workflow", sourcePath: "ui/src/components/NewGoalDialog.tsx", status: "context-required", exampleKind: "registry-only", gaps: "Dialog provider, org data, and mutation callbacks required." },
  { componentId: "NewProjectDialog", category: "workflow", sourcePath: "ui/src/components/NewProjectDialog.tsx", status: "context-required", exampleKind: "registry-only", gaps: "Dialog provider, org data, and mutation callbacks required." },
  { componentId: "sidebarItemStyles", category: "helper", sourcePath: "ui/src/components/sidebarItemStyles.ts", status: "not-renderable", exampleKind: "excluded", gaps: "Style helper, covered through shell components." },
  { componentId: "agent-config-defaults", category: "helper", sourcePath: "ui/src/components/agent-config-defaults.ts", status: "not-renderable", exampleKind: "excluded", gaps: "Pure defaults and tested separately." },
  { componentId: "agent-config-primitives", category: "helper", sourcePath: "ui/src/components/agent-config-primitives.tsx", status: "not-renderable", exampleKind: "excluded", gaps: "Low-level agent form primitives, visible through AgentConfigForm and related forms." },
  { componentId: "approval-ui", category: "helper", sourcePath: "ui/src/components/approval-ui.tsx", status: "not-renderable", exampleKind: "excluded", gaps: "Approval UI helpers, visible through approval cards and dialogs." },
  { componentId: "semanticTones", category: "helper", sourcePath: "ui/src/components/ui/semanticTones.ts", status: "not-renderable", exampleKind: "excluded", gaps: "Token helper, visible through status and semantic components." },
  { componentId: "WorkspaceBackupFilesSidebar", category: "shell", sourcePath: "ui/src/components/WorkspaceBackupFilesSidebar.tsx", status: "context-required", exampleKind: "registry-only", gaps: "Workspace backup file browsing requires backup API data and selected workspace state." },
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
  permissions: { canCreateAgents: true, canManageSkills: true },
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

const fixtureGoals: Goal[] = [
  {
    id: "goal-control-plane",
    orgId: "org-rudder",
    title: "Make reusable UI work reviewable",
    description: "Expose common components in a stable lab.",
    level: "organization",
    status: "active",
    parentId: null,
    ownerAgentId: fixtureAgent.id,
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 14),
    updatedAt: new Date(Date.now() - 1000 * 60 * 60),
  },
  {
    id: "goal-component-inventory",
    orgId: "org-rudder",
    title: "Keep component inventory current",
    description: "Track coverage for reusable components and context-bound gaps.",
    level: "team",
    status: "active",
    parentId: "goal-control-plane",
    ownerAgentId: fixtureAgent.id,
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 7),
    updatedAt: new Date(Date.now() - 1000 * 60 * 30),
  },
];

const fixtureProject: Project = {
  id: "project-ui-lab",
  orgId: "org-rudder",
  urlKey: "ui-lab",
  goalId: fixtureGoals[0]!.id,
  goalIds: [fixtureGoals[0]!.id],
  goals: [{ id: fixtureGoals[0]!.id, title: fixtureGoals[0]!.title }],
  name: "UI Lab",
  description: "A compact review surface for reusable Rudder components.",
  status: "in_progress",
  leadAgentId: fixtureAgent.id,
  targetDate: "2026-06-01",
  color: "#0ea5e9",
  icon: "folder",
  pauseReason: null,
  pausedAt: null,
  executionWorkspacePolicy: null,
  codebase: {
    configured: true,
    scope: "project",
    workspaceId: "workspace-ui-lab",
    repoUrl: null,
    repoRef: null,
    defaultRef: "main",
    repoName: "rudder-oss",
    localFolder: "/Users/zeeland/projects/rudder-oss",
    managedFolder: "/Users/zeeland/.codex/worktrees/ui-lab/rudder-oss",
    effectiveLocalFolder: "/Users/zeeland/projects/rudder-oss",
    origin: "local_folder",
  },
  resources: [],
  workspaces: [],
  primaryWorkspace: null,
  archivedAt: null,
  createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 20),
  updatedAt: new Date(Date.now() - 1000 * 60 * 18),
};

const fixtureBudgetPolicy: BudgetPolicySummary = {
  policyId: "budget-ui-lab",
  orgId: "org-rudder",
  scopeType: "project",
  scopeId: fixtureProject.id,
  scopeName: fixtureProject.name,
  metric: "billed_cents",
  windowKind: "calendar_month_utc",
  amount: 50000,
  observedAmount: 34200,
  remainingAmount: 15800,
  utilizationPercent: 68,
  warnPercent: 80,
  hardStopEnabled: true,
  notifyEnabled: true,
  isActive: true,
  status: "ok",
  paused: false,
  pauseReason: null,
  windowStart: new Date("2026-05-01T00:00:00Z"),
  windowEnd: new Date("2026-06-01T00:00:00Z"),
};

const fixtureBudgetIncident: BudgetIncident = {
  id: "incident-ui-lab",
  orgId: "org-rudder",
  policyId: fixtureBudgetPolicy.policyId,
  scopeType: "agent",
  scopeId: fixtureAgent.id,
  scopeName: fixtureAgent.name,
  metric: "billed_cents",
  windowKind: "calendar_month_utc",
  windowStart: new Date("2026-05-01T00:00:00Z"),
  windowEnd: new Date("2026-06-01T00:00:00Z"),
  thresholdType: "hard",
  amountLimit: 25000,
  amountObserved: 27300,
  status: "open",
  approvalId: fixtureApproval.id,
  approvalStatus: "pending",
  resolvedAt: null,
  createdAt: new Date(Date.now() - 1000 * 60 * 45),
  updatedAt: new Date(Date.now() - 1000 * 60 * 30),
};

const fixtureFinanceKinds: FinanceByKind[] = [
  {
    eventKind: "inference_charge",
    debitCents: 1880,
    creditCents: 0,
    netCents: 1880,
    estimatedDebitCents: 320,
    eventCount: 18,
    billerCount: 2,
  },
  {
    eventKind: "credit_purchase",
    debitCents: 0,
    creditCents: 10000,
    netCents: -10000,
    estimatedDebitCents: 0,
    eventCount: 1,
    billerCount: 1,
  },
];

const fixtureFinanceEvents: FinanceEvent[] = [
  {
    id: "finance-ui-lab-1",
    orgId: "org-rudder",
    agentId: fixtureAgent.id,
    issueId: fixtureIssue.id,
    projectId: fixtureProject.id,
    goalId: fixtureGoals[0]!.id,
    heartbeatRunId: "run-ui-lab",
    costEventId: "cost-ui-lab",
    billingCode: "ui-lab",
    description: "Codex local review loop",
    eventKind: "inference_charge",
    direction: "debit",
    biller: "openai",
    provider: "openai",
    executionAgentRuntimeType: "codex_local",
    pricingTier: "standard",
    region: "us",
    model: "gpt-5",
    quantity: 124000,
    unit: "input_token",
    amountCents: 860,
    currency: "USD",
    estimated: false,
    externalInvoiceId: null,
    metadataJson: null,
    occurredAt: new Date(Date.now() - 1000 * 60 * 25),
    createdAt: new Date(Date.now() - 1000 * 60 * 24),
  },
  {
    id: "finance-ui-lab-2",
    orgId: "org-rudder",
    agentId: null,
    issueId: null,
    projectId: null,
    goalId: null,
    heartbeatRunId: null,
    costEventId: null,
    billingCode: null,
    description: "Monthly account top-up",
    eventKind: "credit_purchase",
    direction: "credit",
    biller: "rudder",
    provider: null,
    executionAgentRuntimeType: null,
    pricingTier: null,
    region: null,
    model: null,
    quantity: 100,
    unit: "credit_usd",
    amountCents: 10000,
    currency: "USD",
    estimated: false,
    externalInvoiceId: "INV-UI-LAB",
    metadataJson: null,
    occurredAt: new Date(Date.now() - 1000 * 60 * 60 * 5),
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 5),
  },
];

const fixtureJsonSchema: JsonSchemaNode = {
  type: "object",
  required: ["model", "temperature"],
  properties: {
    model: {
      type: "string",
      title: "Model",
      enum: ["gpt-5", "claude-sonnet", "gemini-pro"],
      default: "gpt-5",
    },
    temperature: {
      type: "number",
      title: "Temperature",
      minimum: 0,
      maximum: 1,
      default: 0.2,
      description: "Controls response variance.",
    },
    enabled: {
      type: "boolean",
      title: "Enabled",
      default: true,
    },
  },
};

const fixtureFileTree: FileTreeNode[] = [
  {
    name: "ui",
    path: "ui",
    kind: "dir",
    children: [
      {
        name: "src",
        path: "ui/src",
        kind: "dir",
        children: [
          {
            name: "components",
            path: "ui/src/components",
            kind: "dir",
            children: [
              { name: "StatusBadge.tsx", path: "ui/src/components/StatusBadge.tsx", kind: "file", children: [] },
              { name: "IssueRow.tsx", path: "ui/src/components/IssueRow.tsx", kind: "file", children: [] },
            ],
          },
          { name: "pages/UiLab.tsx", path: "ui/src/pages/UiLab.tsx", kind: "file", children: [] },
        ],
      },
    ],
  },
];

const fixtureChatImageSrc = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='96' height='96' viewBox='0 0 96 96'%3E%3Crect width='96' height='96' rx='14' fill='%230f172a'/%3E%3Cpath d='M18 68 37 47l13 13 10-12 18 20H18Z' fill='%2338bdf8'/%3E%3Ccircle cx='64' cy='31' r='8' fill='%23facc15'/%3E%3C/svg%3E";

const fixtureChatConversation: ChatConversation = {
  id: "chat-ui-lab",
  orgId: "org-rudder",
  status: "active",
  title: "UI Lab component review",
  summary: "Fixture conversation for reviewing chat components.",
  latestReplyPreview: "I split the component inventory into visible lab states.",
  latestUserMessagePreview: "Can you split the component inventory into visible lab states?",
  userMessageCount: 1,
  preferredAgentId: fixtureAgent.id,
  routedAgentId: fixtureAgent.id,
  primaryIssueId: fixtureIssue.id,
  primaryIssue: {
    id: fixtureIssue.id,
    identifier: fixtureIssue.identifier,
    title: fixtureIssue.title,
    status: fixtureIssue.status,
    priority: fixtureIssue.priority,
  },
  issueCreationMode: "manual_approval",
  planMode: false,
  createdByUserId: "local-board",
  lastMessageAt: new Date(Date.now() - 1000 * 60 * 3),
  lastReadAt: new Date(Date.now() - 1000 * 60 * 2),
  isPinned: true,
  isUnread: true,
  unreadCount: 2,
  needsAttention: true,
  resolvedAt: null,
  contextLinks: [],
  chatRuntime: {
    sourceType: "agent",
    sourceLabel: fixtureAgent.name,
    runtimeAgentId: fixtureAgent.id,
    agentRuntimeType: fixtureAgent.agentRuntimeType,
    model: "gpt-5",
    available: true,
    error: null,
  },
  createdAt: new Date(Date.now() - 1000 * 60 * 35),
  updatedAt: new Date(Date.now() - 1000 * 60 * 2),
};

const fixtureChatAttachments: ChatMessage["attachments"] = [
  {
    id: "chat-attachment-image",
    orgId: "org-rudder",
    conversationId: fixtureChatConversation.id,
    messageId: "chat-assistant-message",
    assetId: "asset-chat-image",
    provider: "local",
    objectKey: "ui-lab/chat-preview.svg",
    contentType: "image/svg+xml",
    byteSize: 382,
    sha256: "fixture-image-sha",
    originalFilename: "chat-preview.svg",
    createdByAgentId: fixtureAgent.id,
    createdByUserId: null,
    createdAt: new Date(Date.now() - 1000 * 60 * 4),
    updatedAt: new Date(Date.now() - 1000 * 60 * 4),
    contentPath: fixtureChatImageSrc,
  },
  {
    id: "chat-attachment-plan",
    orgId: "org-rudder",
    conversationId: fixtureChatConversation.id,
    messageId: "chat-user-message",
    assetId: "asset-chat-plan",
    provider: "local",
    objectKey: "doc/DESIGN.md",
    contentType: "text/markdown",
    byteSize: 4096,
    sha256: "fixture-plan-sha",
    originalFilename: "DESIGN.md",
    createdByAgentId: null,
    createdByUserId: "local-board",
    createdAt: new Date(Date.now() - 1000 * 60 * 6),
    updatedAt: new Date(Date.now() - 1000 * 60 * 6),
    contentPath: "file:///Users/zeeland/projects/rudder-oss/doc/DESIGN.md",
  },
];

const fixtureChatAskUserRequest: ChatAskUserRequest = {
  questions: [
    {
      id: "scope",
      header: "Scope",
      question: "Which chat surfaces should the lab prioritize?",
      options: [
        { id: "common", label: "Common components", description: "Messages, attachments, and input requests.", recommended: true },
        { id: "full-page", label: "Full page", description: "Route-owned chat shell and live generation state." },
      ],
      allowFreeform: true,
    },
    {
      id: "evidence",
      header: "Evidence",
      question: "What evidence should be collected before handoff?",
      options: [
        { id: "browser", label: "Browser screenshot", recommended: true },
        { id: "coverage", label: "Coverage search" },
      ],
      selectionMode: "multiple",
      allowFreeform: true,
    },
  ],
};

const fixtureChatAskUserAnswer = [
  {
    questionId: "scope",
    title: "Scope",
    answer: "Show the common chat components, not only the route shell.",
  },
  {
    questionId: "evidence",
    title: "Evidence",
    answer: "Use the UI Lab E2E path and a browser check.",
  },
];

function fixtureChatMessage(overrides: Partial<ChatMessage> & Pick<ChatMessage, "id" | "role" | "body">): ChatMessage {
  const createdAt = new Date(Date.now() - 1000 * 60 * 5);
  return {
    orgId: "org-rudder",
    conversationId: fixtureChatConversation.id,
    kind: "message",
    status: "completed",
    structuredPayload: null,
    approvalId: null,
    approval: null,
    attachments: [],
    replyingAgentId: null,
    chatTurnId: "turn-ui-lab",
    turnVariant: 1,
    supersededAt: null,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

const fixtureChatUserMessage = fixtureChatMessage({
  id: "chat-user-message",
  role: "user",
  body: "Can you make the UI Lab show the common chat states?",
  attachments: [fixtureChatAttachments[1]!],
});

const fixtureChatAssistantMessage = fixtureChatMessage({
  id: "chat-assistant-message",
  role: "assistant",
  body: [
    "I will expose the chat prompt options, message rows, attachment chips, ask-user states, and process transcript states in the lab.",
    "",
    "This keeps the component review surface close to the real Messenger experience.",
  ].join("\n"),
  attachments: [fixtureChatAttachments[0]!],
  replyingAgentId: fixtureAgent.id,
});

const fixtureChatProposalCreatedAt = new Date(Date.now() - 1000 * 60 * 5);
const fixtureChatProposalDecidedAt = new Date(fixtureChatProposalCreatedAt.getTime() + 1000 * 60);

const fixtureChatProposalMessage = fixtureChatMessage({
  id: "chat-proposal-message",
  role: "assistant",
  kind: "issue_proposal",
  body: "I can turn this chat into a reviewable issue before implementation.",
  structuredPayload: {
    issueProposal: {
      title: "Add chat components to UI Lab",
      description: "Render common Messenger and chat message states in the internal UI Lab.",
      priority: "high",
      assigneeAgentId: fixtureAgent.id,
      reviewerUserId: "local-board",
    },
  },
  approvalId: "approval-ui-lab-chat-proposal",
  approval: {
    id: "approval-ui-lab-chat-proposal",
    orgId: "org-ui-lab",
    type: "chat_issue_creation",
    requestedByAgentId: fixtureAgent.id,
    requestedByUserId: null,
    status: "revision_requested",
    payload: {},
    decisionNote: "Tighten the acceptance criteria and show how this avoids duplicating the existing Messenger states.",
    decidedByUserId: "local-board",
    decidedAt: fixtureChatProposalDecidedAt,
    createdAt: fixtureChatProposalCreatedAt,
    updatedAt: fixtureChatProposalDecidedAt,
  },
  replyingAgentId: fixtureAgent.id,
  createdAt: fixtureChatProposalCreatedAt,
  updatedAt: fixtureChatProposalDecidedAt,
});

const fixtureChatSystemMessage = fixtureChatMessage({
  id: "chat-system-message",
  role: "system",
  kind: "system_event",
  body: "Created issue RUD-214 from this chat conversation.",
  structuredPayload: {
    eventType: "issue_created",
    issueId: fixtureIssue.id,
    issueIdentifier: fixtureIssue.identifier,
  },
});

const fixtureChatAskUserMessage = fixtureChatMessage({
  id: "chat-ask-user-message",
  role: "assistant",
  kind: "ask_user",
  body: "I need one product decision before finishing the lab surface.",
  structuredPayload: {
    requestUserInput: fixtureChatAskUserRequest,
  },
  replyingAgentId: fixtureAgent.id,
});

const fixtureChatRichReferenceMessage = fixtureChatMessage({
  id: "chat-rich-reference-message",
  role: "assistant",
  body: "I referenced the implementation issue for context.",
  structuredPayload: {
    richReferences: [
      {
        type: "issue",
        issueId: "00000000-0000-4000-8000-000000000214",
        display: "card",
      },
    ],
  },
  replyingAgentId: fixtureAgent.id,
});

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
  const [agentIcon, setAgentIcon] = useState<string | null>("robot:bg-emerald");
  const [datePreset, setDatePreset] = useState<DashboardDatePreset>("15d");
  const [customDateOpen, setCustomDateOpen] = useState(false);
  const [customFrom, setCustomFrom] = useState("2026-05-01");
  const [customTo, setCustomTo] = useState("2026-05-25");
  const [heartbeatOn, setHeartbeatOn] = useState(true);
  const [schedule, setSchedule] = useState("0 10 * * 1-5");
  const [resourceLocator, setResourceLocator] = useState("/Users/zeeland/projects/rudder-oss/doc/DESIGN.md");
  const [jsonValues, setJsonValues] = useState<Record<string, unknown>>({
    model: "gpt-5",
    temperature: 0.2,
    enabled: true,
  });
  const [selectedPageTab, setSelectedPageTab] = useState("overview");
  const [selectedFile, setSelectedFile] = useState("ui/src/pages/UiLab.tsx");
  const [expandedDirs, setExpandedDirs] = useState(() => new Set(["ui", "ui/src", "ui/src/components"]));
  const [checkedFiles, setCheckedFiles] = useState(() => new Set(["ui/src/components/StatusBadge.tsx", "ui/src/pages/UiLab.tsx"]));
  const [selectedEntity, setSelectedEntity] = useState("issue-ui-lab");
  const [reportsTo, setReportsTo] = useState<string | null>("agent-cto");
  const [chatPreview, setChatPreview] = useState<AttachmentPreviewState | null>(null);
  const [chatDecisionNote, setChatDecisionNote] = useState("");
  const pendingChatFile = useMemo(() => {
    if (typeof File === "undefined") return null;
    return new File(["UI Lab chat fixture"], "lab-answer.txt", {
      type: "text/plain",
      lastModified: Date.now() - 1000 * 60 * 2,
    });
  }, []);

  const chartDays = useMemo(() => {
    const today = new Date();
    return Array.from({ length: 7 }, (_, index) => {
      const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (6 - index), 12);
      return date.toISOString().slice(0, 10);
    });
  }, []);
  const chartIssues = useMemo(
    () => chartDays.flatMap((day, index) => [
      {
        priority: index % 3 === 0 ? "critical" : index % 2 === 0 ? "high" : "medium",
        status: index % 4 === 0 ? "in_review" : index % 3 === 0 ? "done" : "in_progress",
        createdAt: new Date(`${day}T12:00:00`),
      },
      ...(index % 2 === 0
        ? [{
            priority: "low",
            status: "todo",
            createdAt: new Date(`${day}T15:00:00`),
          }]
        : []),
    ]),
    [chartDays],
  );
  const managerAgent = useMemo<Agent>(() => ({
    ...fixtureAgent,
    id: "agent-cto",
    name: "CTO",
    urlKey: "cto",
    role: "cto",
    title: "Technical Lead",
    icon: "person:bg-sky",
  }), []);

  const toggleDir = (path: string) => {
    setExpandedDirs((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const toggleCheckedFile = (path: string) => {
    setCheckedFiles((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

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

        <LabExample title="Agent avatar, picker, and properties">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <span className="flex h-12 w-12 items-center justify-center rounded-full border border-border bg-muted">
                  <AgentIcon icon={agentIcon} role={fixtureAgent.role} className="h-6 w-6" />
                </span>
                <div className="min-w-0">
                  <AgentIdentity name="Design Lead" icon={agentIcon} role={fixtureAgent.role} />
                  <p className="mt-1 text-xs text-muted-foreground">Popover-based icon picker with local fixture state.</p>
                </div>
              </div>
              <AgentIconPicker value={agentIcon} onChange={setAgentIcon}>
                <Button size="sm" variant="outline">Choose avatar</Button>
              </AgentIconPicker>
            </div>
            <div className="rounded-md border border-border p-3">
              <AgentProperties
                agent={fixtureAgent}
                runtimeState={{
                  agentId: fixtureAgent.id,
                  orgId: fixtureAgent.orgId,
                  agentRuntimeType: fixtureAgent.agentRuntimeType,
                  sessionId: "session-ui-lab-123456",
                  sessionDisplayId: "ui-lab-session",
                  sessionParamsJson: null,
                  stateJson: {},
                  lastRunId: "run-ui-lab",
                  lastRunStatus: "succeeded",
                  totalInputTokens: 124000,
                  totalOutputTokens: 36000,
                  totalCachedInputTokens: 48000,
                  totalCostCents: 142,
                  lastError: null,
                  createdAt: new Date(Date.now() - 1000 * 60 * 60 * 2),
                  updatedAt: new Date(Date.now() - 1000 * 60 * 5),
                }}
              />
            </div>
          </div>
        </LabExample>

        <LabExample title="Approval payload">
          <ApprovalPayloadRenderer
            type="hire_agent"
            payload={{
              name: "Reviewer Agent",
              role: "qa",
              title: "UI Reviewer",
              capabilities: "Reviews visible component and route changes before handoff.",
              agentRuntimeType: "codex_local",
              desiredSkills: ["agent-work-reviewer-maintainer", "rudder-ui-polish-maintainer"],
            }}
          />
        </LabExample>

        <LabExample title="Chat prompts, messages, and process states">
          <div className="space-y-5">
            <ChatEmptyStatePromptOptions
              group={EMPTY_STATE_PROMPT_GROUPS[0]!}
              optionsId="ui-lab-chat-prompt-options"
              entered
              originX="36%"
              onExampleSelect={() => {}}
            />

            <div className="rounded-md border border-border bg-card/60 p-3">
              <ChatAssistantAttributionRow
                replyingAgentId={fixtureAgent.id}
                conversation={fixtureChatConversation}
                agents={[fixtureAgent]}
              />
              <ChatLongMessageBody
                body="ChatLongMessageBody keeps assistant markdown readable inside the real chat typography."
                skillReferences={[]}
                className="max-w-[72ch] text-[15px] leading-7 text-foreground"
              />
              <div className="chat-system-pill mt-3 rounded-[calc(var(--radius-sm)+2px)] px-4 py-2 text-sm">
                <ChatSystemMessageBody
                  message={fixtureChatSystemMessage}
                  skillReferences={[]}
                />
              </div>
            </div>

            <div className="space-y-3 rounded-md border border-border bg-background p-3">
              <ChatMessageItem
                conversation={fixtureChatConversation}
                message={fixtureChatUserMessage}
                agents={[fixtureAgent]}
                decisionNote={chatDecisionNote}
                onDecisionNoteChange={setChatDecisionNote}
                onApprovalAction={() => {}}
                onResolveOperationProposal={() => {}}
                onConvertToIssue={() => {}}
                actionPending={false}
                onCopyMessageText={() => {}}
                onEditUserMessage={() => {}}
                onContinueInterruptedMessage={() => {}}
                onRetryFailedMessage={() => {}}
                onOpenImage={setChatPreview}
                onOpenFile={() => {}}
                skillReferences={[]}
              />
              <ChatMessageItem
                conversation={fixtureChatConversation}
                message={fixtureChatAssistantMessage}
                agents={[fixtureAgent]}
                decisionNote={chatDecisionNote}
                onDecisionNoteChange={setChatDecisionNote}
                onApprovalAction={() => {}}
                onResolveOperationProposal={() => {}}
                onConvertToIssue={() => {}}
                actionPending={false}
                onCopyMessageText={() => {}}
                onEditUserMessage={() => {}}
                onContinueInterruptedMessage={() => {}}
                onRetryFailedMessage={() => {}}
                onOpenImage={setChatPreview}
                onOpenFile={() => {}}
                skillReferences={[]}
              />
              <ChatMessageItem
                conversation={fixtureChatConversation}
                message={fixtureChatProposalMessage}
                agents={[fixtureAgent]}
                decisionNote={chatDecisionNote}
                onDecisionNoteChange={setChatDecisionNote}
                onApprovalAction={() => {}}
                onResolveOperationProposal={() => {}}
                onConvertToIssue={() => {}}
                actionPending={false}
                onCopyMessageText={() => {}}
                onEditUserMessage={() => {}}
                onContinueInterruptedMessage={() => {}}
                onRetryFailedMessage={() => {}}
                onOpenImage={setChatPreview}
                onOpenFile={() => {}}
                skillReferences={[]}
              />
            </div>

            <div className="space-y-3 rounded-md border border-border bg-card/60 p-3">
              <OptimisticUserDraftItem
                body="Draft answer that has not been persisted yet."
                createdAt={new Date(Date.now() - 1000 * 45)}
                onCopyMessageText={() => {}}
                onEditDraftOnly={() => {}}
                skillReferences={[]}
              />
              <AssistantDraftItem
                body="Checking the chat component inventory..."
                createdAt={new Date(Date.now() - 1000 * 30)}
                state="finalizing"
                replyingAgentId={fixtureAgent.id}
                conversation={fixtureChatConversation}
                agents={[fixtureAgent]}
                onCopyMessageText={() => {}}
                skillReferences={[]}
              />
              <StreamTranscriptItem
                entries={runTranscriptFixtureEntries.slice(1, 5)}
                state="completed"
                streamStartedAt={new Date("2026-03-11T15:21:05.948Z")}
                streamEndedAt={new Date("2026-03-11T15:21:18.952Z")}
                assistantMessageBody="Checking the chat component inventory..."
                defaultOpen
              />
              <ChatMessagesLoadingState />
            </div>
          </div>
        </LabExample>

        <LabExample title="Chat composer surface">
          <div className="space-y-4">
            <div className="chat-composer rounded-[var(--radius-lg)] p-3">
              <div
                data-testid="ui-lab-chat-composer-editor"
                className="chat-field min-h-[104px] rounded-[var(--radius-md)] px-3 py-2.5 text-[15px] leading-7"
                aria-label="Chat composer draft"
              >
                Ask the design lead to review the UI Lab chat fixtures and call out any missing common component states.
              </div>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2.5" data-testid="chat-composer-toolbar">
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[color:var(--border-soft)] bg-[color:color-mix(in_oklab,var(--surface-active)_52%,transparent)] text-foreground transition-colors hover:bg-[color:var(--surface-active)] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring/40"
                    aria-label="Add files and options"
                  >
                    <Paperclip className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    role="switch"
                    aria-checked="true"
                    aria-label="Plan mode"
                    className="chat-chip inline-flex items-center gap-2 rounded-[var(--radius-md)] px-3 py-1.5 text-xs font-medium"
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    <span>Plan mode</span>
                  </button>
                  <button
                    type="button"
                    className="chat-chip inline-flex max-w-[min(100%,15rem)] min-w-0 items-center gap-1.5 rounded-[var(--radius-md)] px-3 py-1.5 text-xs font-medium"
                    aria-label="Project context: UI Lab"
                  >
                    <Folder className="h-3.5 w-3.5 shrink-0" />
                    <span className="min-w-0 truncate">UI Lab</span>
                    <ChevronDown className="h-3 w-3 shrink-0 opacity-70" />
                  </button>
                  <button
                    type="button"
                    className="chat-chip inline-flex max-w-[min(100%,16rem)] min-w-0 items-center gap-1.5 rounded-[var(--radius-md)] px-3 py-1.5 text-xs font-medium"
                    aria-label="Agent selector: Design Lead"
                  >
                    <Bot className="h-3.5 w-3.5 shrink-0" />
                    <span className="min-w-0 truncate">Design Lead</span>
                    <ChevronDown className="h-3 w-3 shrink-0 opacity-70" />
                  </button>
                  <button
                    type="button"
                    className="chat-chip inline-flex max-w-[min(100%,18rem)] min-w-0 items-center gap-1.5 rounded-[var(--radius-md)] px-3 py-1.5 text-xs font-medium"
                    aria-label="Skills"
                  >
                    <span className="min-w-0 truncate">$rudder-ui-polish-maintainer</span>
                    <ChevronDown className="h-3 w-3 shrink-0 opacity-70" />
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <Button type="button" variant="ghost" size="icon-sm" aria-label="Send" className="rounded-full bg-white text-black hover:bg-zinc-100 dark:bg-white dark:text-black">
                    <Send className="h-[17px] w-[17px]" />
                  </Button>
                  <Button type="button" variant="ghost" size="icon-sm" aria-label="Stop streaming" className="rounded-full border border-border">
                    <Square className="h-3.5 w-3.5 fill-current" />
                  </Button>
                </div>
              </div>
              {pendingChatFile ? (
                <div data-testid="chat-pending-attachments" className="mt-2.5 flex flex-wrap gap-2">
                  <PendingAttachmentPreview
                    file={pendingChatFile}
                    onOpenImage={setChatPreview}
                    onRemove={() => {}}
                  />
                </div>
              ) : null}
            </div>

            <div className="chat-composer rounded-[var(--radius-lg)] p-3">
              <div className="chat-field min-h-[70px] rounded-[var(--radius-md)] px-3 py-2.5 text-sm text-muted-foreground">
                Message blocked until a chat agent can receive work.
              </div>
              <div className="chat-warning mt-2.5 rounded-[var(--radius-md)] px-3 py-2.5 text-sm">
                Create or activate an agent before sending messages. <span className="underline underline-offset-4">Open agents</span>
              </div>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="chat-chip inline-flex items-center gap-1.5 rounded-[var(--radius-md)] px-3 py-1.5 text-xs font-medium text-muted-foreground">
                    <Bot className="h-3.5 w-3.5" />
                    No active agent
                  </span>
                </div>
                <Button type="button" variant="ghost" size="icon-sm" aria-label="Send disabled" disabled className="rounded-full bg-white text-black dark:bg-white dark:text-black">
                  <Send className="h-[17px] w-[17px]" />
                </Button>
              </div>
            </div>
          </div>
        </LabExample>

        <LabExample title="Chat attachments, rich references, and input requests">
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-3">
              <ChatImageAttachmentTile
                src={fixtureChatImageSrc}
                name="chat-preview.svg"
                onOpen={() => setChatPreview({ src: fixtureChatImageSrc, name: "chat-preview.svg" })}
              />
              <ChatFileAttachmentChip
                name="DESIGN.md"
                href="file:///Users/zeeland/projects/rudder-oss/doc/DESIGN.md"
                onOpenFile={() => {}}
              />
              {pendingChatFile ? (
                <PendingAttachmentPreview
                  file={pendingChatFile}
                  onOpenImage={setChatPreview}
                  onRemove={() => {}}
                />
              ) : null}
            </div>

            <div>
              <p className="mb-2 text-xs font-medium text-muted-foreground">Attachment list</p>
              <ChatAttachmentList
                attachments={fixtureChatAttachments}
                onOpenImage={setChatPreview}
                onOpenFile={() => {}}
              />
            </div>

            <div>
              <p className="mb-2 text-xs font-medium text-muted-foreground">Rich reference fallback</p>
              <ChatRichReferences message={fixtureChatRichReferenceMessage} />
            </div>

            <AskUserHistoryRecord
              message={fixtureChatAskUserMessage}
              request={fixtureChatAskUserRequest}
              answered={false}
              conversation={fixtureChatConversation}
              agents={[fixtureAgent]}
              skillReferences={[]}
            />
            <AskUserAnswerBubble answer={fixtureChatAskUserAnswer} />
            <AskUserPanel
              message={fixtureChatAskUserMessage}
              request={fixtureChatAskUserRequest}
              disabled={false}
              pendingFiles={pendingChatFile ? [pendingChatFile] : []}
              onAddAttachment={() => {}}
              onRemovePendingFile={() => {}}
              onOpenAttachmentPreview={setChatPreview}
              onPasteAttachment={() => {}}
              onSubmit={() => {}}
            />
            <ChatAttachmentPreviewDialog
              preview={chatPreview}
              onOpenChange={(open) => {
                if (!open) setChatPreview(null);
              }}
            />
          </div>
        </LabExample>

        <LabExample title="Tabs, date range, and heartbeat controls">
          <div className="space-y-4">
            <Tabs value={selectedPageTab} onValueChange={setSelectedPageTab}>
              <PageTabBar
                value={selectedPageTab}
                onValueChange={setSelectedPageTab}
                align="start"
                items={[
                  { value: "overview", label: "Overview" },
                  { value: "activity", label: "Activity", tooltip: "Recent work loop signal" },
                  { value: "coverage", label: "Coverage" },
                ]}
              />
              <TabsContent value="overview" className="pt-3 text-sm text-muted-foreground">Overview tab content</TabsContent>
              <TabsContent value="activity" className="pt-3 text-sm text-muted-foreground">Activity tab content</TabsContent>
              <TabsContent value="coverage" className="pt-3 text-sm text-muted-foreground">Coverage tab content</TabsContent>
            </Tabs>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <DashboardDateRangeControl
                preset={datePreset}
                customFrom={customFrom}
                customTo={customTo}
                customOpen={customDateOpen}
                onCustomOpenChange={setCustomDateOpen}
                onPresetSelect={setDatePreset}
                onCustomFromChange={setCustomFrom}
                onCustomToChange={setCustomTo}
              />
              <HeartbeatEnabledButtons
                onPressed={heartbeatOn}
                disabled={false}
                onEnable={() => setHeartbeatOn(true)}
                onDisable={() => setHeartbeatOn(false)}
              />
            </div>
          </div>
        </LabExample>

        <LabExample title="Charts, selectors, and sidebar rows">
          <div className="space-y-4">
            <div className="grid gap-3 md:grid-cols-2">
              <ChartCard title="Issue priority mix" subtitle="Fixture data rendered through the dashboard chart primitives.">
                <PriorityChart issues={chartIssues} days={chartDays} />
              </ChartCard>
              <ChartCard title="Issue status mix" subtitle="Stacked status distribution using the same daily buckets.">
                <IssueStatusChart issues={chartIssues} days={chartDays} />
              </ChartCard>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <InlineEntitySelector
                value={selectedEntity}
                options={[
                  { id: "issue-ui-lab", label: "RUD-214 Build UI Lab", searchText: "ui lab component inventory" },
                  { id: "goal-component-inventory", label: "Keep component inventory current", searchText: "goals coverage" },
                ]}
                placeholder="Select entity"
                noneLabel="No entity"
                searchPlaceholder="Search entities..."
                emptyMessage="No entities match."
                onChange={setSelectedEntity}
                variant="field"
              />
              <ReportsToPicker
                agents={[managerAgent, fixtureAgent]}
                value={reportsTo}
                onChange={setReportsTo}
                excludeAgentIds={[fixtureAgent.id]}
              />
            </div>
            <div className="rounded-md border border-border p-2">
              <SidebarSection label="Lab sidebar">
                <SidebarSectionHeader
                  label="Components"
                  action={<SidebarSectionActionButton aria-label="Add component" onClick={() => {}}>+</SidebarSectionActionButton>}
                />
                <SidebarNavItem to="/ui-lab" icon={Component} label="Common Components" />
                <SidebarNavItem to="/ui-lab" icon={ListFilter} label="Coverage Registry" />
              </SidebarSection>
            </div>
          </div>
        </LabExample>

        <LabExample title="Schedule and resource locator">
          <div className="space-y-4">
            <ScheduleEditor value={schedule} onChange={setSchedule} variant="compact" />
            <ResourceLocatorField kind="file" value={resourceLocator} onChange={setResourceLocator} />
          </div>
        </LabExample>

        <LabExample title="Schema form">
          <JsonSchemaForm
            schema={fixtureJsonSchema}
            values={jsonValues}
            onChange={setJsonValues}
            errors={{ "/temperature": "Recommended range for this fixture is 0.1 to 0.7." }}
          />
        </LabExample>

        <LabExample title="File tree">
          <PackageFileTree
            nodes={fixtureFileTree}
            selectedFile={selectedFile}
            expandedDirs={expandedDirs}
            checkedFiles={checkedFiles}
            onToggleDir={toggleDir}
            onSelectFile={setSelectedFile}
            onToggleCheck={(path) => toggleCheckedFile(path)}
            renderFileExtra={(node) => node.path === selectedFile ? <Badge variant="outline">Selected</Badge> : null}
          />
        </LabExample>

        <LabExample title="Markdown, skill token, and goal tree">
          <div className="space-y-4">
            <MarkdownBody agentMentions={[{ name: "Holden", agentId: "ui-lab-agent-holden", agentIcon: "code" }]}>
              {[
                "A component lab entry should include **real rendered state**, compact fixture data, and a clear coverage row.",
                "",
                "@Holden should render as an agent mention chip when a comment calls for agent attention.",
                "",
                "- Keep examples deterministic.",
                "- Use workflow E2E for behavior-heavy surfaces.",
              ].join("\n")}
            </MarkdownBody>
            <p className="text-sm">
              <SkillReferenceToken
                label="$rudder-ui-polish-maintainer"
                preview={{
                  href: "skill://rudder-ui-polish-maintainer",
                  displayName: "rudder-ui-polish-maintainer",
                  categoryLabel: "Maintainer",
                  locationLabel: ".agents/skills/maintainer",
                  description: "Screenshot-driven Rudder UI polish and narrow visible interaction fixes.",
                  detailsHref: "/skills/rudder-ui-polish-maintainer",
                }}
              />
            </p>
            <GoalTree goals={fixtureGoals} onSelect={() => {}} />
          </div>
        </LabExample>

        <LabExample title="Goal and project properties">
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-md border border-border p-3">
              <GoalProperties goal={fixtureGoals[0]!} />
            </div>
            <div className="rounded-md border border-border p-3">
              <ProjectProperties project={fixtureProject} />
            </div>
          </div>
        </LabExample>

        <LabExample title="Budget and finance cards">
          <div className="space-y-4">
            <BudgetPolicyCard summary={fixtureBudgetPolicy} compact variant="plain" />
            <BudgetIncidentCard
              incident={fixtureBudgetIncident}
              onRaiseAndResume={() => {}}
              onKeepPaused={() => {}}
            />
            <div className="grid gap-4 lg:grid-cols-2">
              <FinanceKindCard rows={fixtureFinanceKinds} />
              <FinanceTimelineCard rows={fixtureFinanceEvents} />
            </div>
          </div>
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
            <div className="rounded-md border border-border p-4">
              <RudderLogo className="h-8 w-auto" />
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
