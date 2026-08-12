import { Button } from "@/components/ui/button";
import { readDesktopShell } from "@/lib/desktop-shell";
import type { SidePanelTarget } from "@/lib/side-panel-targets";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { RotateCw, TerminalSquare } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

type TerminalTarget = Extract<SidePanelTarget, { kind: "terminal" }>;

export function terminalErrorMessage(cause: unknown): string {
  if (!(cause instanceof Error)) return "Terminal failed to start.";
  const message = cause.message
    .replace(/^Error invoking remote method '[^']+':\s*/u, "")
    .replace(/^Error:\s*/u, "")
    .trim();
  return message || "Terminal failed to start.";
}

export function TerminalPanelView({ active, target }: { active: boolean; target: TerminalTarget }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const generationRef = useRef(0);
  const sessionRequestedRef = useRef(false);
  const activeRef = useRef(active);
  const [state, setState] = useState<"starting" | "running" | "exited" | "failed">("starting");
  const [error, setError] = useState<string | null>(null);

  const start = useCallback(async () => {
    const desktop = readDesktopShell()?.terminal;
    const terminal = terminalRef.current;
    const fit = fitRef.current;
    if (!desktop?.supported || !terminal || !fit) {
      setState("failed");
      setError("Terminal is available only in Rudder Desktop.");
      return;
    }
    if (!target.agentId) {
      setState("failed");
      setError("Select an Agent for this Chat before starting a terminal.");
      return;
    }
    if (!activeRef.current || sessionRequestedRef.current) return;
    const dimensions = fit.proposeDimensions();
    if (!dimensions || dimensions.cols <= 2 || dimensions.rows <= 1) return;
    fit.fit();
    sessionRequestedRef.current = true;
    const generation = ++generationRef.current;
    setState("starting");
    setError(null);
    terminal.reset();
    try {
      const result = await desktop.create({
        orgId: target.organizationId,
        agentId: target.agentId,
        sessionId: target.sessionId,
        cols: Math.max(2, terminal.cols),
        rows: Math.max(1, terminal.rows),
      });
      if (generation !== generationRef.current) return;
      if (result.replay) terminal.write(result.replay);
      setState(result.status === "running" ? "running" : "exited");
      if (activeRef.current) terminal.focus();
    } catch (cause) {
      if (generation !== generationRef.current) return;
      setState("failed");
      setError(terminalErrorMessage(cause));
    }
  }, [target.agentId, target.organizationId, target.sessionId]);

  useEffect(() => {
    const host = hostRef.current;
    const desktop = readDesktopShell()?.terminal;
    if (!host || !desktop?.supported) {
      setState("failed");
      setError("Terminal is available only in Rudder Desktop.");
      return undefined;
    }
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: false,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 5_000,
      theme: { background: "#111315", foreground: "#e7e9ea", cursor: "#f4f4f5", selectionBackground: "#3f4650" },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    terminalRef.current = terminal;
    fitRef.current = fit;
    const inputSubscription = terminal.onData((data) => void desktop.input(target.sessionId, data).catch(() => undefined));
    const resizeSubscription = terminal.onResize(({ cols, rows }) => void desktop.resize(target.sessionId, cols, rows).catch(() => undefined));
    const removeOutput = desktop.onOutput((event) => {
      if (event.sessionId === target.sessionId) terminal.write(event.data);
    });
    const removeExit = desktop.onExit((event) => {
      if (event.sessionId !== target.sessionId) return;
      setState(event.error ? "failed" : "exited");
      setError(event.error);
    });
    const observer = new ResizeObserver(() => {
      fit.fit();
      if (activeRef.current && !sessionRequestedRef.current) void start();
    });
    observer.observe(host);
    const frame = requestAnimationFrame(() => {
      if (activeRef.current) void start();
    });
    return () => {
      generationRef.current += 1;
      cancelAnimationFrame(frame);
      observer.disconnect();
      inputSubscription.dispose();
      resizeSubscription.dispose();
      removeOutput();
      removeExit();
      terminal.dispose();
      sessionRequestedRef.current = false;
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [start, target.sessionId]);

  useEffect(() => {
    activeRef.current = active;
    if (!active) return;
    const frame = requestAnimationFrame(() => {
      fitRef.current?.fit();
      if (!sessionRequestedRef.current) void start();
      terminalRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active, start]);

  return (
    <div className="relative h-full min-h-0 bg-[#111315]" data-testid="terminal-panel-view">
      <div className="h-full min-h-0 min-w-0 p-2">
        <div ref={hostRef} className="h-full min-h-0 min-w-0 w-full overflow-hidden" data-testid="terminal-xterm-host" />
      </div>
      {state !== "running" ? (
        <div className="absolute inset-0 flex items-center justify-center bg-[#111315]/95 px-6">
          <div className="max-w-xs text-center text-zinc-200">
            <TerminalSquare className="mx-auto h-7 w-7 text-zinc-500" aria-hidden />
            <h3 className="mt-3 text-sm font-semibold">{state === "starting" ? "Starting terminal" : state === "exited" ? "Shell exited" : "Terminal unavailable"}</h3>
            {error ? <p className="mt-2 text-xs leading-5 text-zinc-400">{error}</p> : null}
            {state !== "starting" ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="mt-4 border-zinc-700 bg-zinc-900 text-zinc-100 hover:bg-zinc-800"
                onClick={() => {
                  sessionRequestedRef.current = false;
                  void start();
                }}
              >
                <RotateCw className="h-3.5 w-3.5" />
                Restart terminal
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
