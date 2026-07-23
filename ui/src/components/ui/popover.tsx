import { Popover as PopoverPrimitive } from "radix-ui";
import * as React from "react";

import { LiquidGlassSurface } from "@/components/ui/liquid-glass-surface";
import { cn } from "@/lib/utils";

function Popover({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

function PopoverContent({
  className,
  children,
  align = "center",
  sideOffset = 4,
  disablePortal = false,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content> & { disablePortal?: boolean }) {
  const content = (
    <PopoverPrimitive.Content
      data-slot="popover-content"
      align={align}
      sideOffset={sideOffset}
      className={cn(
        "liquid-glass-host motion-surface-pop bg-popover text-popover-foreground z-50 w-72 origin-(--radix-popover-content-transform-origin) rounded-md border p-4 shadow-md outline-hidden",
        className
      )}
      {...props}
    >
      <LiquidGlassSurface variant="menu" />
      {children}
    </PopoverPrimitive.Content>
  )
  if (disablePortal) return content
  return <PopoverPrimitive.Portal>{content}</PopoverPrimitive.Portal>
}

function PopoverAnchor({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />
}

function PopoverHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="popover-header"
      className={cn("flex flex-col gap-1 text-sm", className)}
      {...props}
    />
  )
}

function PopoverTitle({ className, ...props }: React.ComponentProps<"h2">) {
  return (
    <div
      data-slot="popover-title"
      className={cn("font-medium", className)}
      {...props}
    />
  )
}

function PopoverDescription({
  className,
  ...props
}: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="popover-description"
      className={cn("text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Popover, PopoverAnchor, PopoverContent, PopoverDescription, PopoverHeader,
  PopoverTitle, PopoverTrigger
};
