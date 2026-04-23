import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export interface FilterValue {
  key: string;
  label: string;
  value: string;
}

interface FilterBarProps {
  filters: FilterValue[];
  onRemove: (key: string) => void;
  onClear: () => void;
}

export function FilterBar({ filters, onRemove, onClear }: FilterBarProps) {
  if (filters.length === 0) return null;

  return (
    <div className="surface-inset flex flex-wrap items-center gap-2 rounded-[var(--radius-md)] px-3 py-3">
      {filters.map((f) => (
        <Badge key={f.key} variant="outline" className="gap-1.5 border-[color:var(--border-base)] bg-[color:color-mix(in_oklab,var(--surface-elevated)_95%,transparent)] pr-1.5">
          <span className="text-muted-foreground">{f.label}:</span>
          <span>{f.value}</span>
          <button
            className="ml-1 rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onClick={() => onRemove(f.key)}
          >
            <X className="h-3 w-3" />
          </button>
        </Badge>
      ))}
      <Button variant="quiet" size="sm" className="h-8 text-xs" onClick={onClear}>
        Clear all
      </Button>
    </div>
  );
}
