export interface IssueTimelineInitialSettlement {
  key: string;
  status: "failed" | "pending" | "ready";
}

export function resolveIssueTimelineInitialSettlement(
  current: IssueTimelineInitialSettlement,
  key: string,
  input: { allSuccessful: boolean; hasError: boolean },
): IssueTimelineInitialSettlement {
  if (current.key !== key) {
    return {
      key,
      status: input.hasError ? "failed" : input.allSuccessful ? "ready" : "pending",
    };
  }
  if (current.status !== "pending") return current;
  if (input.hasError) return { ...current, status: "failed" };
  if (input.allSuccessful) return { ...current, status: "ready" };
  return current;
}

