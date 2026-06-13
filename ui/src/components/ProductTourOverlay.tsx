import { Button } from "@/components/ui/button";
import { useDialog } from "@/context/DialogContext";
import { useI18n } from "@/context/I18nContext";
import { useNavigate } from "@/lib/router";
import { cn } from "@/lib/utils";
import { Check, ChevronLeft, ChevronRight, Circle, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const PRODUCT_TOUR_STORAGE_KEY = "rudder.productTour.completed.v1";
const PRODUCT_TOUR_PENDING_STORAGE_KEY = "rudder.productTour.pendingAfterSetup.v1";

type ProductTourStep = {
  id: string;
  target: string;
  checklistKey: string;
  titleKey: Parameters<ReturnType<typeof useI18n>["t"]>[0];
  bodyKey: Parameters<ReturnType<typeof useI18n>["t"]>[0];
};

const TOUR_STEPS: ProductTourStep[] = [
  {
    id: "workspace",
    target: "[data-tour-target='primary-rail']",
    checklistKey: "productTour.checklist.workspace",
    titleKey: "productTour.step.workspace.title",
    bodyKey: "productTour.step.workspace.body",
  },
  {
    id: "create",
    target: "[data-tour-target='create-menu']",
    checklistKey: "productTour.checklist.create",
    titleKey: "productTour.step.create.title",
    bodyKey: "productTour.step.create.body",
  },
  {
    id: "issues",
    target: "[data-tour-target='issues-nav']",
    checklistKey: "productTour.checklist.issues",
    titleKey: "productTour.step.issues.title",
    bodyKey: "productTour.step.issues.body",
  },
  {
    id: "inspect",
    target: "[data-tour-target='workspace-main']",
    checklistKey: "productTour.checklist.inspect",
    titleKey: "productTour.step.inspect.title",
    bodyKey: "productTour.step.inspect.body",
  },
  {
    id: "settings",
    target: "[data-settings-trigger='true']",
    checklistKey: "productTour.checklist.settings",
    titleKey: "productTour.step.settings.title",
    bodyKey: "productTour.step.settings.body",
  },
];

type TargetRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type FloatingBounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

type FloatingBox = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type ChecklistPosition = {
  left?: number;
  right?: number;
  top: number;
};

const TOUR_MARGIN = 16;
const DESKTOP_MAC_MIN_LEFT = 96;
const DESKTOP_MAC_MIN_TOP = 48;
const CHECKLIST_WIDTH = 220;
const CHECKLIST_ESTIMATED_HEIGHT = 214;
const COMPACT_RAIL_SPOTLIGHT_WIDTH = 52;
const CALLOUT_ESTIMATED_HEIGHT = 232;
const FLOATING_GAP = 16;

function isMacDesktopShellTour(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.classList.contains("desktop-shell-macos");
}

function getFloatingBounds(): FloatingBounds {
  if (isMacDesktopShellTour()) {
    return {
      left: DESKTOP_MAC_MIN_LEFT,
      top: DESKTOP_MAC_MIN_TOP,
      right: TOUR_MARGIN,
      bottom: TOUR_MARGIN,
    };
  }
  return {
    left: TOUR_MARGIN,
    top: TOUR_MARGIN,
    right: TOUR_MARGIN,
    bottom: TOUR_MARGIN,
  };
}

export function hasCompletedProductTour() {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(PRODUCT_TOUR_STORAGE_KEY) === "true";
  } catch {
    return true;
  }
}

export function hasPendingProductTour() {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(PRODUCT_TOUR_PENDING_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function markProductTourPending() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PRODUCT_TOUR_PENDING_STORAGE_KEY, "true");
  } catch {
    // Ignore restricted storage environments.
  }
}

function markProductTourComplete() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PRODUCT_TOUR_STORAGE_KEY, "true");
    window.localStorage.removeItem(PRODUCT_TOUR_PENDING_STORAGE_KEY);
  } catch {
    // Ignore restricted storage environments.
  }
}

function getViewportFallbackRect(): TargetRect {
  const width = Math.min(520, Math.max(260, window.innerWidth * 0.48));
  const height = Math.min(220, Math.max(130, window.innerHeight * 0.26));
  return {
    left: Math.round((window.innerWidth - width) / 2),
    top: Math.round((window.innerHeight - height) / 2),
    width: Math.round(width),
    height: Math.round(height),
  };
}

function resolveTargetRect(selector: string): TargetRect {
  const target = document.querySelector<HTMLElement>(selector);
  if (!target) return getViewportFallbackRect();
  const rect = target.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return getViewportFallbackRect();
  const compactRail = target.dataset.tourSpotlight === "compact-rail";
  const spotlightWidth = compactRail ? Math.min(rect.width, COMPACT_RAIL_SPOTLIGHT_WIDTH) : rect.width;
  const left = compactRail ? rect.left + (rect.width - spotlightWidth) / 2 : rect.left;
  const padding = compactRail ? 4 : 6;
  return {
    left: Math.max(8, Math.round(left - padding)),
    top: Math.max(8, Math.round(rect.top - padding)),
    width: Math.round(spotlightWidth + padding * 2),
    height: Math.round(rect.height + padding * 2),
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function floatingBoxesOverlap(a: FloatingBox, b: FloatingBox, gap = 8) {
  return (
    a.left < b.left + b.width + gap &&
    a.left + a.width + gap > b.left &&
    a.top < b.top + b.height + gap &&
    a.top + a.height + gap > b.top
  );
}

function getCalloutPosition(rect: TargetRect) {
  const bounds = getFloatingBounds();
  const width = Math.min(360, Math.max(292, window.innerWidth - 32));
  const maxLeft = Math.max(bounds.left, window.innerWidth - width - bounds.right);
  const fitsRight = rect.left + rect.width + FLOATING_GAP + width <= window.innerWidth - bounds.right;
  const fitsLeft = rect.left - FLOATING_GAP - width >= bounds.left;
  const left = fitsRight
    ? rect.left + rect.width + FLOATING_GAP
    : fitsLeft
      ? rect.left - FLOATING_GAP - width
      : Math.max(bounds.left, Math.min(maxLeft, rect.left));
  const top = Math.max(bounds.top, Math.min(window.innerHeight - 250 - bounds.bottom, rect.top));
  return {
    width,
    left,
    top,
    height: CALLOUT_ESTIMATED_HEIGHT,
  };
}

function getChecklistPosition(callout: FloatingBox): ChecklistPosition {
  const bounds = getFloatingBounds();
  if (isMacDesktopShellTour()) {
    return {
      top: bounds.top,
      right: bounds.right,
    };
  }

  const maxLeft = Math.max(bounds.left, window.innerWidth - CHECKLIST_WIDTH - bounds.right);
  const maxTop = Math.max(bounds.top, window.innerHeight - CHECKLIST_ESTIMATED_HEIGHT - bounds.bottom);
  const top = Math.max(bounds.top, 20);
  const candidates: FloatingBox[] = [
    {
      left: maxLeft,
      top,
      width: CHECKLIST_WIDTH,
      height: CHECKLIST_ESTIMATED_HEIGHT,
    },
    {
      left: Math.max(bounds.left, 20),
      top,
      width: CHECKLIST_WIDTH,
      height: CHECKLIST_ESTIMATED_HEIGHT,
    },
    {
      left: clamp(callout.left, bounds.left, maxLeft),
      top: clamp(callout.top + callout.height + FLOATING_GAP, bounds.top, maxTop),
      width: CHECKLIST_WIDTH,
      height: CHECKLIST_ESTIMATED_HEIGHT,
    },
    {
      left: clamp(callout.left, bounds.left, maxLeft),
      top: clamp(callout.top - CHECKLIST_ESTIMATED_HEIGHT - FLOATING_GAP, bounds.top, maxTop),
      width: CHECKLIST_WIDTH,
      height: CHECKLIST_ESTIMATED_HEIGHT,
    },
  ];
  const candidate = candidates.find((box) => !floatingBoxesOverlap(box, callout)) ?? candidates[0]!;

  return {
    left: Math.round(candidate.left),
    top: Math.round(candidate.top),
  };
}

export function ProductTourOverlay() {
  const { t } = useI18n();
  const { productTourOpen, closeProductTour } = useDialog();
  const navigate = useNavigate();
  const [stepIndex, setStepIndex] = useState(0);
  const [targetRect, setTargetRect] = useState<TargetRect | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const openedIssuesDuringTourRef = useRef(false);
  const activeStep = TOUR_STEPS[stepIndex] ?? TOUR_STEPS[0]!;
  const isLastStep = stepIndex === TOUR_STEPS.length - 1;

  const refreshTarget = useCallback(() => {
    setTargetRect(resolveTargetRect(activeStep.target));
  }, [activeStep.target]);

  useEffect(() => {
    if (!productTourOpen) return;
    setStepIndex(0);
    openedIssuesDuringTourRef.current = false;
  }, [productTourOpen]);

  useEffect(() => {
    if (!productTourOpen) return;
    refreshTarget();
    const raf = window.requestAnimationFrame(refreshTarget);
    window.addEventListener("resize", refreshTarget);
    window.addEventListener("scroll", refreshTarget, true);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener("resize", refreshTarget);
      window.removeEventListener("scroll", refreshTarget, true);
    };
  }, [productTourOpen, refreshTarget]);

  useEffect(() => {
    if (!productTourOpen) return;
    dialogRef.current?.focus();
  }, [productTourOpen, stepIndex]);

  const calloutPosition = useMemo(
    () => (targetRect ? getCalloutPosition(targetRect) : null),
    [targetRect],
  );
  const checklistPosition = useMemo(
    () => (calloutPosition ? getChecklistPosition(calloutPosition) : null),
    [calloutPosition],
  );

  const dismiss = useCallback(() => {
    const shouldOpenIssuesAfterSetup = hasPendingProductTour();
    markProductTourComplete();
    closeProductTour();
    if (shouldOpenIssuesAfterSetup && !openedIssuesDuringTourRef.current) {
      navigate("/issues");
    }
  }, [closeProductTour, navigate]);

  const goToStep = useCallback(
    (nextIndex: number) => {
      const normalizedIndex = clamp(nextIndex, 0, TOUR_STEPS.length - 1);
      const nextStep = TOUR_STEPS[normalizedIndex] ?? TOUR_STEPS[0]!;
      if (nextStep.id === "issues") {
        openedIssuesDuringTourRef.current = true;
        navigate("/issues");
      }
      setStepIndex(normalizedIndex);
    },
    [navigate],
  );

  if (!productTourOpen || !targetRect || !calloutPosition || !checklistPosition) {
    return null;
  }

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="product-tour-title"
      tabIndex={-1}
      className="fixed inset-0 z-[90] outline-none"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          dismiss();
        }
      }}
    >
      <div
        aria-hidden="true"
        data-testid="product-tour-spotlight"
        className="pointer-events-none fixed rounded-[10px] border-2 border-[color:color-mix(in_oklab,var(--accent-base)_72%,white)] shadow-[0_0_0_9999px_rgb(18_17_15/0.68),0_0_0_5px_color-mix(in_oklab,var(--accent-base)_18%,transparent)]"
        style={{
          left: targetRect.left,
          top: targetRect.top,
          width: targetRect.width,
          height: targetRect.height,
        }}
      />

      <aside
        data-testid="product-tour-checklist"
        className="fixed hidden rounded-[var(--radius-md)] border border-[color:color-mix(in_oklab,var(--border-strong)_72%,transparent)] bg-popover/98 p-3 text-popover-foreground shadow-[var(--shadow-lg)] backdrop-blur md:block"
        style={{
          ...checklistPosition,
          width: CHECKLIST_WIDTH,
        }}
      >
        <div className="mb-2 text-[13px] font-semibold text-foreground">{t("productTour.checklist.title")}</div>
        <div className="space-y-0.5">
          {TOUR_STEPS.map((step, index) => (
            <div
              key={step.id}
              className={cn(
                "grid min-h-8 grid-cols-[18px_minmax(0,1fr)] items-center gap-2 border-t border-[color:color-mix(in_oklab,var(--border-soft)_76%,transparent)] py-1.5 text-[12px]",
                index === 0 && "border-t-0",
                index === stepIndex ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {index < stepIndex ? (
                <Check className="h-3.5 w-3.5 rounded-full bg-[color:var(--accent-base)] p-0.5 text-primary-foreground" />
              ) : (
                <Circle className={cn("h-3.5 w-3.5", index === stepIndex && "text-[color:var(--accent-strong)]")} />
              )}
              <span>{t(step.checklistKey as ProductTourStep["titleKey"])}</span>
            </div>
          ))}
        </div>
      </aside>

      <section
        data-testid="product-tour-callout"
        className="fixed rounded-[var(--radius-md)] border border-[color:color-mix(in_oklab,var(--border-strong)_74%,transparent)] bg-popover/98 p-3.5 text-popover-foreground shadow-[var(--shadow-lg)] backdrop-blur"
        style={{
          left: calloutPosition.left,
          top: calloutPosition.top,
          width: calloutPosition.width,
        }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="mb-1 text-[11px] text-muted-foreground">
              {t("productTour.stepCounter", { current: stepIndex + 1, total: TOUR_STEPS.length })}
            </div>
            <h2 id="product-tour-title" className="text-[15px] font-semibold leading-5 text-foreground">
              {t(activeStep.titleKey)}
            </h2>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="-mr-1 -mt-1 text-muted-foreground"
            onClick={dismiss}
            aria-label={t("productTour.skip")}
            title={t("productTour.skip")}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        <p className="mt-2 text-[13px] leading-5 text-muted-foreground">{t(activeStep.bodyKey)}</p>
        <div className="mt-4 flex items-center justify-between gap-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8"
            disabled={stepIndex === 0}
            onClick={() => goToStep(stepIndex - 1)}
          >
            <ChevronLeft className="h-4 w-4" />
            {t("productTour.back")}
          </Button>
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" className="h-8" onClick={dismiss}>
              {t("productTour.skip")}
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-8"
              onClick={() => {
                if (isLastStep) {
                  dismiss();
                  return;
                }
                goToStep(stepIndex + 1);
              }}
            >
              {isLastStep ? t("productTour.finish") : t("productTour.next")}
              {isLastStep ? <Check className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
