import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { Plus, Trash2 } from "lucide-react";
import { useCallback, useMemo } from "react";
import { normalizeWorkspaceCsvRows, parseWorkspaceCsvContent, serializeWorkspaceCsvRows } from "../../lib/workspace-csv";

export function LegacyHeartbeatInstructionsDialog({
  open,
  filePath,
  isDeleting,
  onKeep,
  onDeleteAll,
}: {
  open: boolean;
  filePath: string | null;
  isDeleting: boolean;
  onKeep: () => void;
  onDeleteAll: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => {
      if (!nextOpen && !isDeleting) onKeep();
    }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Legacy HEARTBEAT.md</DialogTitle>
          <DialogDescription>
            Heartbeat instructions are built into Rudder runtime now. Agents no longer load or need
            {filePath ? ` ${filePath}` : " this file"}, so you do not need to maintain it by hand.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onKeep} disabled={isDeleting}>
            Keep files for now
          </Button>
          <Button type="button" variant="destructive" onClick={onDeleteAll} disabled={isDeleting}>
            {isDeleting ? "Deleting..." : "Delete all legacy HEARTBEAT.md files"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CsvWorkspaceEditor({
  content,
  filePath,
  mode,
  onChange,
  onModeChange,
  scrollRef,
}: {
  content: string;
  filePath: string | null;
  mode: "table" | "source";
  onChange: (filePath: string | null, content: string) => void;
  onModeChange: (mode: "table" | "source") => void;
  scrollRef: (element: HTMLElement | null) => void;
}) {
  const parsed = useMemo(() => parseWorkspaceCsvContent(content), [content]);
  const { rows, columnCount } = useMemo(() => normalizeWorkspaceCsvRows(parsed.rows), [parsed.rows]);
  const bodyRows = rows.slice(1);

  const commitRows = useCallback((nextRows: string[][]) => {
    onChange(
      filePath,
      serializeWorkspaceCsvRows(nextRows, parsed.lineEnding, parsed.hasTrailingLineBreak),
    );
  }, [filePath, onChange, parsed.hasTrailingLineBreak, parsed.lineEnding]);

  const updateCell = useCallback((rowIndex: number, columnIndex: number, value: string) => {
    const nextRows = parsed.rows.map((row) => [...row]);
    nextRows[rowIndex] = nextRows[rowIndex] ?? Array.from({ length: columnCount }, () => "");
    while (nextRows[rowIndex]!.length <= columnIndex) nextRows[rowIndex]!.push("");
    nextRows[rowIndex]![columnIndex] = value;
    commitRows(nextRows);
  }, [columnCount, commitRows, parsed.rows]);

  const addRow = useCallback(() => {
    commitRows([...rows, Array.from({ length: columnCount }, () => "")]);
  }, [columnCount, commitRows, rows]);

  const addColumn = useCallback(() => {
    commitRows(rows.map((row) => [...row, ""]));
  }, [commitRows, rows]);

  const removeRow = useCallback((rowIndex: number) => {
    if (rows.length <= 1) {
      commitRows([Array.from({ length: columnCount }, () => "")]);
      return;
    }
    commitRows(rows.filter((_, index) => index !== rowIndex));
  }, [columnCount, commitRows, rows]);

  const removeColumn = useCallback((columnIndex: number) => {
    if (columnCount <= 1) {
      commitRows(rows.map(() => [""]));
      return;
    }
    commitRows(rows.map((row) => row.filter((_, index) => index !== columnIndex)));
  }, [columnCount, commitRows, rows]);

  const renderCell = (value: string, rowIndex: number, columnIndex: number, header = false) => (
    <textarea
      key={`${rowIndex}:${columnIndex}`}
      value={value}
      rows={Math.min(4, Math.max(1, value.split(/\r\n|\r|\n/u).length))}
      spellCheck={false}
      aria-label={`CSV cell row ${rowIndex + 1} column ${columnIndex + 1}`}
      data-testid={`org-workspaces-csv-cell-${rowIndex}-${columnIndex}`}
      onChange={(event) => updateCell(rowIndex, columnIndex, event.target.value)}
      className={cn(
        "block min-h-9 w-full min-w-[12rem] resize-y overflow-auto border-0 bg-transparent px-2.5 py-2 text-sm leading-5 text-foreground outline-none focus:bg-[color:var(--surface-page)] focus:ring-1 focus:ring-inset focus:ring-ring",
        header ? "font-semibold" : "font-normal",
      )}
    />
  );

  return (
    <div ref={scrollRef} data-testid="org-workspaces-csv-editor" className="scrollbar-auto-hide flex min-h-[280px] flex-1 flex-col overflow-auto bg-[color:var(--surface-elevated)]">
      <div className="sticky top-0 z-20 flex shrink-0 items-center justify-between gap-3 border-b border-border bg-[color:var(--surface-page)] px-4 py-2">
        <div className="min-w-0 truncate text-xs text-muted-foreground">
          {rows.length.toLocaleString()} {rows.length === 1 ? "row" : "rows"} / {columnCount.toLocaleString()} {columnCount === 1 ? "column" : "columns"}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <ToggleGroup type="single" variant="outline" size="sm" spacing={0} value={mode} onValueChange={(value) => {
            if (value === "table" || value === "source") onModeChange(value);
          }} aria-label="CSV file mode">
            <ToggleGroupItem value="table">Table</ToggleGroupItem>
            <ToggleGroupItem value="source">Source</ToggleGroupItem>
          </ToggleGroup>
          {mode === "table" ? (
            <>
              <Button type="button" variant="outline" size="sm" className="h-7 rounded-[4px] px-2 text-xs" onClick={addColumn} data-testid="org-workspaces-csv-add-column">
                <Plus className="h-3.5 w-3.5" />
                Column
              </Button>
              <Button type="button" variant="outline" size="sm" className="h-7 rounded-[4px] px-2 text-xs" onClick={addRow} data-testid="org-workspaces-csv-add-row">
                <Plus className="h-3.5 w-3.5" />
                Row
              </Button>
            </>
          ) : null}
        </div>
      </div>
      {mode === "source" ? (
        <textarea data-testid="org-workspaces-csv-source-textarea" value={content} onChange={(event) => onChange(filePath, event.target.value)} spellCheck={false} className="block min-h-[280px] flex-1 overflow-auto border-0 bg-transparent px-4 py-4 font-mono text-sm leading-6 text-foreground outline-none" />
      ) : (
        <div className="min-w-max flex-1 p-4">
          <table className="border-separate border-spacing-0 text-left" aria-label="CSV editor table">
            <thead>
              <tr>
                <th className="sticky left-0 top-[45px] z-20 h-9 w-12 border-y border-l border-border bg-[color:var(--surface-page)] text-center text-xs font-medium text-muted-foreground">#</th>
                {rows[0]?.map((value, columnIndex) => (
                  <th key={columnIndex} className="sticky top-[45px] z-10 min-w-[12rem] border-y border-l border-border bg-[color:var(--surface-page)] align-top last:border-r">
                    <div className="flex min-w-0 items-stretch">
                      <div className="min-w-0 flex-1">{renderCell(value, 0, columnIndex, true)}</div>
                      <Button type="button" variant="ghost" size="icon-xs" className="m-1 h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive" aria-label={`Remove CSV column ${columnIndex + 1}`} onClick={() => removeColumn(columnIndex)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bodyRows.map((row, bodyIndex) => {
                const rowIndex = bodyIndex + 1;
                return (
                  <tr key={rowIndex}>
                    <th className="sticky left-0 z-10 h-9 w-12 border-b border-l border-border bg-[color:var(--surface-page)] text-center align-middle text-xs font-medium text-muted-foreground">
                      <div className="flex items-center justify-center gap-1">
                        <span>{rowIndex + 1}</span>
                        <Button type="button" variant="ghost" size="icon-xs" className="h-6 w-6 text-muted-foreground hover:text-destructive" aria-label={`Remove CSV row ${rowIndex + 1}`} onClick={() => removeRow(rowIndex)}>
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    </th>
                    {row.map((value, columnIndex) => (
                      <td key={columnIndex} className="min-w-[12rem] border-b border-l border-border align-top last:border-r">
                        {renderCell(value, rowIndex, columnIndex)}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
