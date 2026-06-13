import {
  type AgentRuntimeEnvironmentTestResult
} from "@rudderhq/shared";
import { formatTime } from "../lib/utils";
import {
  filterRuntimeEnvironmentDisplayChecks,
  normalizeRuntimeEnvironmentDisplayStatus,
} from "./AgentConfigForm";


export function AdapterEnvironmentResult({
  result
}: {
  result: AgentRuntimeEnvironmentTestResult;
}) {
  const displayStatus = normalizeRuntimeEnvironmentDisplayStatus(result.status) ?? "pass";
  const visibleChecks = filterRuntimeEnvironmentDisplayChecks(result);
  const statusLabel =
    displayStatus === "pass" ? "Passed" : "Failed";
  const statusClass =
    displayStatus === "pass"
      ? "text-green-700 dark:text-green-300 border-green-300 dark:border-green-500/40 bg-green-50 dark:bg-green-500/10"
      : "text-red-700 dark:text-red-300 border-red-300 dark:border-red-500/40 bg-red-50 dark:bg-red-500/10";

  return (
    <div className={`rounded-md border px-2.5 py-2 text-[11px] ${statusClass}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{statusLabel}</span>
        <span className="opacity-80">
          {formatTime(result.testedAt)}
        </span>
      </div>
      {visibleChecks.length > 0 ? (
        <div className="mt-1.5 space-y-1">
          {visibleChecks.map((check, idx) => (
            <div
              key={`${check.code}-${idx}`}
              className="leading-relaxed break-words"
            >
              <span className="font-medium uppercase tracking-wide opacity-80">
                {check.level}
              </span>
              <span className="mx-1 opacity-60">·</span>
              <span>{check.message}</span>
              {check.detail && (
                <span className="block opacity-75 break-all">
                  ({check.detail})
                </span>
              )}
              {check.hint && (
                <span className="block opacity-90 break-words">
                  Hint: {check.hint}
                </span>
              )}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

