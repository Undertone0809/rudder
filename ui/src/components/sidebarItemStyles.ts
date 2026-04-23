import { cva } from "class-variance-authority";

export const sidebarItemVariants = cva(
  "flex items-center gap-2.5 rounded-[calc(var(--radius-sm)-1px)] border text-[13px] font-medium transition-[background-color,color,border-color,box-shadow]",
  {
    variants: {
      variant: {
        default: "px-3 py-2.5",
        compact: "px-3 py-1.5",
      },
      active: {
        true: "surface-active border-[color:var(--border-strong)] text-foreground",
        false:
          "border-transparent text-foreground/80 hover:border-[color:var(--border-soft)] hover:bg-[color:color-mix(in_oklab,var(--surface-active)_52%,transparent)] hover:text-foreground",
      },
    },
    compoundVariants: [
      {
        variant: "default",
        active: true,
        className: "shadow-[var(--shadow-sm)]",
      },
    ],
    defaultVariants: {
      variant: "default",
      active: false,
    },
  },
);
