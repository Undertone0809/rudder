import type { CSSProperties, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";

interface MetricCardProps {
  icon: LucideIcon;
  value: string | number;
  label: string;
  description?: ReactNode;
  to?: string;
  onClick?: () => void;
}

interface MetricGlyph {
  key: string;
  current: string;
  previous: string;
  isDigit: boolean;
}

function buildMetricGlyphs(currentValue: string, previousValue: string): MetricGlyph[] {
  const previousDigits = previousValue.match(/\d/g) ?? [];
  const currentDigitCount = currentValue.match(/\d/g)?.length ?? 0;
  let currentDigitIndex = 0;

  return Array.from(currentValue).map((current, index, chars) => {
    const isDigit = /\d/.test(current);
    if (!isDigit) {
      return {
        key: `${index}-${current}`,
        current,
        previous: current,
        isDigit: false,
      };
    }

    const currentDigitOffsetFromEnd = currentDigitCount - 1 - currentDigitIndex;
    const previousDigit = previousDigits[previousDigits.length - 1 - currentDigitOffsetFromEnd] ?? current;
    currentDigitIndex += 1;

    return {
      key: `${chars.length - index}-${current}`,
      current,
      previous: previousDigit,
      isDigit: true,
    };
  });
}

function AnimatedMetricValue({ value }: { value: string | number }) {
  const displayValue = String(value);
  const currentValueRef = useRef(displayValue);
  const previousValueRef = useRef(displayValue);
  const [animationKey, setAnimationKey] = useState(0);

  useEffect(() => {
    if (displayValue === currentValueRef.current) return;

    previousValueRef.current = currentValueRef.current;
    currentValueRef.current = displayValue;
    setAnimationKey((key) => key + 1);
  }, [displayValue]);

  const glyphs = useMemo(
    () => buildMetricGlyphs(displayValue, previousValueRef.current),
    [displayValue, animationKey],
  );

  return (
    <span
      aria-label={displayValue}
      className="metric-value-motion"
      data-animated={animationKey > 0 ? "true" : "false"}
    >
      {glyphs.map((glyph, index) => (
        glyph.isDigit ? (
          <span
            key={`${animationKey}-${glyph.key}`}
            aria-hidden="true"
            className="metric-digit-window"
            style={{ "--metric-glyph-index": index } as CSSProperties}
          >
            <span className="metric-digit-stack">
              <span>{glyph.previous}</span>
              <span>{glyph.current}</span>
            </span>
          </span>
        ) : (
          <span
            key={`${animationKey}-${glyph.key}`}
            aria-hidden="true"
            className="metric-symbol"
            style={{ "--metric-glyph-index": index } as CSSProperties}
          >
            {glyph.current}
          </span>
        )
      ))}
    </span>
  );
}

export function MetricCard({ icon: Icon, value, label, description, to, onClick }: MetricCardProps) {
  const isClickable = !!(to || onClick);

  const inner = (
    <div
      className={cn(
        "surface-panel h-full rounded-[var(--radius-lg)] px-4 py-4 sm:px-5 sm:py-5 transition-[background-color,border-color,transform]",
        isClickable && "cursor-pointer hover:surface-active",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-2xl sm:text-3xl font-semibold tracking-tight tabular-nums text-foreground">
            <AnimatedMetricValue value={value} />
          </p>
          <p className="mt-1 text-xs font-medium tracking-[0.06em] text-muted-foreground sm:text-sm">
            {label}
          </p>
          {description && (
            <div className="mt-2 hidden text-xs leading-5 text-muted-foreground/85 sm:block">{description}</div>
          )}
        </div>
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[calc(var(--radius-sm)+2px)] border border-[color:var(--border-soft)] bg-[color:color-mix(in_oklab,var(--surface-inset)_92%,transparent)]">
          <Icon className="h-4 w-4 text-[color:var(--accent-strong)]" />
        </div>
      </div>
    </div>
  );

  if (to) {
    return (
      <Link to={to} className="no-underline text-inherit h-full" onClick={onClick}>
        {inner}
      </Link>
    );
  }

  if (onClick) {
    return (
      <div className="h-full" onClick={onClick}>
        {inner}
      </div>
    );
  }

  return inner;
}
