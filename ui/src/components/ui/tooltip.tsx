"use client"

import { Tooltip as TooltipPrimitive } from "radix-ui";
import * as React from "react";

import { LiquidGlassSurface, type LiquidGlassVariant } from "@/components/ui/liquid-glass-surface";
import { cn } from "@/lib/utils";

function TooltipProvider({
  delayDuration = 300,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  )
}

function Tooltip({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

function TooltipTrigger({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  glassVariant = "tooltip",
  sideOffset = 0,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content> & {
  glassVariant?: LiquidGlassVariant
}) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          "liquid-glass-host motion-tooltip bg-foreground text-white z-50 w-fit origin-(--radix-tooltip-content-transform-origin) rounded-md border px-3 py-1.5 text-xs text-balance",
          className
        )}
        {...props}
      >
        <LiquidGlassSurface variant={glassVariant} />
        {children}
        <TooltipPrimitive.Arrow className="rudder-tooltip-arrow z-50 size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px] bg-[rgb(34_36_37/0.9)] fill-[rgb(34_36_37/0.9)]" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
