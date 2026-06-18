import type {
  EnvBinding,
  OrganizationSecret
} from "@rudderhq/shared";
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useDialog } from "../context/DialogContext";
import { cn } from "../lib/utils";
import { inputClass } from "./AgentConfigForm.helpers";

/* ---- Create mode values ---- */

// Canonical type lives in @rudderhq/agent-runtime-utils; re-exported here
// so existing imports from this file keep working.
export type { CreateConfigValues } from "@rudderhq/agent-runtime-utils";

export function EnvVarEditor({
  value,
  secrets,
  onCreateSecret,
  onChange,
  disabled = false,
}: {
  value: Record<string, EnvBinding>;
  secrets: OrganizationSecret[];
  onCreateSecret: (name: string, value: string) => Promise<OrganizationSecret>;
  onChange: (env: Record<string, EnvBinding> | undefined) => void;
  disabled?: boolean;
}) {
  const { promptText } = useDialog();
  type Row = {
    key: string;
    source: "plain" | "secret";
    plainValue: string;
    secretId: string;
  };

  function toRows(rec: Record<string, EnvBinding> | null | undefined): Row[] {
    if (!rec || typeof rec !== "object") {
      return [{ key: "", source: "plain", plainValue: "", secretId: "" }];
    }
    const entries = Object.entries(rec).map(([k, binding]) => {
      if (typeof binding === "string") {
        return {
          key: k,
          source: "plain" as const,
          plainValue: binding,
          secretId: "",
        };
      }
      if (
        typeof binding === "object" &&
        binding !== null &&
        "type" in binding &&
        (binding as { type?: unknown }).type === "secret_ref"
      ) {
        const recBinding = binding as { secretId?: unknown };
        return {
          key: k,
          source: "secret" as const,
          plainValue: "",
          secretId: typeof recBinding.secretId === "string" ? recBinding.secretId : "",
        };
      }
      if (
        typeof binding === "object" &&
        binding !== null &&
        "type" in binding &&
        (binding as { type?: unknown }).type === "plain"
      ) {
        const recBinding = binding as { value?: unknown };
        return {
          key: k,
          source: "plain" as const,
          plainValue: typeof recBinding.value === "string" ? recBinding.value : "",
          secretId: "",
        };
      }
      return {
        key: k,
        source: "plain" as const,
        plainValue: "",
        secretId: "",
      };
    });
    return [...entries, { key: "", source: "plain", plainValue: "", secretId: "" }];
  }

  const [rows, setRows] = useState<Row[]>(() => toRows(value));
  const [sealError, setSealError] = useState<string | null>(null);
  const valueRef = useRef(value);

  // Sync when value identity changes (overlay reset after save)
  useEffect(() => {
    if (value !== valueRef.current) {
      valueRef.current = value;
      setRows(toRows(value));
    }
  }, [value]);

  function emit(nextRows: Row[]) {
    const rec: Record<string, EnvBinding> = {};
    for (const row of nextRows) {
      const k = row.key.trim();
      if (!k) continue;
      if (row.source === "secret") {
        if (!row.secretId) continue;
        rec[k] = { type: "secret_ref", secretId: row.secretId, version: "latest" };
      } else {
        rec[k] = { type: "plain", value: row.plainValue };
      }
    }
    onChange(Object.keys(rec).length > 0 ? rec : undefined);
  }

  function updateRow(i: number, patch: Partial<Row>) {
    const withPatch = rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r));
    if (
      withPatch[withPatch.length - 1].key ||
      withPatch[withPatch.length - 1].plainValue ||
      withPatch[withPatch.length - 1].secretId
    ) {
      withPatch.push({ key: "", source: "plain", plainValue: "", secretId: "" });
    }
    setRows(withPatch);
    emit(withPatch);
  }

  function removeRow(i: number) {
    const next = rows.filter((_, idx) => idx !== i);
    if (
      next.length === 0 ||
      next[next.length - 1].key ||
      next[next.length - 1].plainValue ||
      next[next.length - 1].secretId
    ) {
      next.push({ key: "", source: "plain", plainValue: "", secretId: "" });
    }
    setRows(next);
    emit(next);
  }

  function defaultSecretName(key: string): string {
    return key
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 64);
  }

  async function sealRow(i: number) {
    const row = rows[i];
    if (!row) return;
    const key = row.key.trim();
    const plain = row.plainValue;
    if (!key || plain.length === 0) return;

    const suggested = defaultSecretName(key) || "secret";
    const name = (await promptText({
      title: "Secret name",
      label: "Name",
      defaultValue: suggested,
      confirmLabel: "Create secret",
    }))?.trim();
    if (!name) return;

    try {
      setSealError(null);
      const created = await onCreateSecret(name, plain);
      updateRow(i, {
        source: "secret",
        secretId: created.id,
      });
    } catch (err) {
      setSealError(err instanceof Error ? err.message : "Failed to create secret");
    }
  }

  return (
    <div className="space-y-1.5">
      {rows.map((row, i) => {
        const isTrailing =
          i === rows.length - 1 &&
          !row.key &&
          !row.plainValue &&
          !row.secretId;
        return (
          <div key={i} className="flex items-center gap-1.5">
            <input
              className={cn(inputClass, "flex-[2]")}
              placeholder="KEY"
              value={row.key}
              disabled={disabled}
              onChange={(e) => updateRow(i, { key: e.target.value })}
            />
            <select
              className={cn(inputClass, "flex-[1] bg-background")}
              value={row.source}
              disabled={disabled}
              onChange={(e) =>
                updateRow(i, {
                  source: e.target.value === "secret" ? "secret" : "plain",
                  ...(e.target.value === "plain" ? { secretId: "" } : {}),
                })
              }
            >
              <option value="plain">Plain</option>
              <option value="secret">Secret</option>
            </select>
            {row.source === "secret" ? (
              <>
                <select
                  className={cn(inputClass, "flex-[3] bg-background")}
                  value={row.secretId}
                  disabled={disabled}
                  onChange={(e) => updateRow(i, { secretId: e.target.value })}
                >
                  <option value="">Select secret...</option>
                  {secrets.map((secret) => (
                    <option key={secret.id} value={secret.id}>
                      {secret.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="inline-flex items-center rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent/50 transition-colors shrink-0"
                  onClick={() => sealRow(i)}
                  disabled={disabled || !row.key.trim() || !row.plainValue}
                  title="Create secret from current plain value"
                >
                  New
                </button>
              </>
            ) : (
              <>
                <input
                  className={cn(inputClass, "flex-[3]")}
                  placeholder="value"
                  value={row.plainValue}
                  disabled={disabled}
                  onChange={(e) => updateRow(i, { plainValue: e.target.value })}
                />
                <button
                  type="button"
                  className="inline-flex items-center rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent/50 transition-colors shrink-0"
                  onClick={() => sealRow(i)}
                  disabled={disabled || !row.key.trim() || !row.plainValue}
                  title="Store value as secret and replace with reference"
                >
                  Seal
                </button>
              </>
            )}
            {!isTrailing ? (
              <button
                type="button"
                className="shrink-0 p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                disabled={disabled}
                onClick={() => removeRow(i)}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : (
              <div className="w-[26px] shrink-0" />
            )}
          </div>
        );
      })}
      {sealError && <p className="text-[11px] text-destructive">{sealError}</p>}
      <p className="text-[11px] text-muted-foreground/60">
        RUDDER_* variables are injected automatically at runtime.
      </p>
    </div>
  );
}
