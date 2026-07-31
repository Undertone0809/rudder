import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import * as React from "react";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "control-hover inline-flex items-center justify-center gap-[var(--control-gap)] whitespace-nowrap rounded-[var(--control-radius)] border font-medium transition-[color,background-color,border-color,box-shadow,opacity,transform,scale] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-[var(--control-icon-size)] shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground shadow-[var(--shadow-sm)] hover:bg-[color-mix(in_oklab,var(--primary)_86%,white)]",
        destructive:
          "border-transparent bg-destructive text-white shadow-[var(--shadow-sm)] hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/80",
        outline:
          "border-[color:var(--border-base)] bg-[color:var(--surface-elevated)] text-foreground shadow-none hover:bg-[color:var(--surface-active)] hover:text-foreground",
        secondary:
          "border-[color:color-mix(in_oklab,var(--border-soft)_94%,transparent)] bg-secondary text-secondary-foreground hover:bg-[color:var(--surface-active)] hover:text-foreground",
        quiet:
          "border-[color:transparent] bg-[color:var(--surface-inset)] text-muted-foreground shadow-none hover:border-[color:var(--border-soft)] hover:bg-[color:var(--surface-active)] hover:text-foreground",
        ghost:
          "border-[color:transparent] bg-transparent text-muted-foreground shadow-none hover:border-[color:var(--border-soft)] hover:bg-[color:var(--surface-active)] hover:text-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-[var(--control-height)] px-[var(--control-padding-x)] py-2 text-[length:var(--control-font-size)] has-[>svg]:px-[calc(var(--control-padding-x)-0.25rem)]",
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-[var(--control-height-sm)] gap-[var(--control-gap)] px-[var(--control-padding-x-sm)] text-[length:var(--control-font-size)] has-[>svg]:px-[calc(var(--control-padding-x-sm)-0.125rem)]",
        lg: "h-[var(--control-height-lg)] px-[calc(var(--control-padding-x)+0.5rem)] text-[length:var(--control-font-size)] has-[>svg]:px-[var(--control-padding-x)]",
        icon: "size-[var(--control-height)]",
        "icon-xs": "size-6 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-[var(--control-height-sm)]",
        "icon-lg": "size-[var(--control-height-lg)]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  draggable = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      draggable={draggable}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants };
