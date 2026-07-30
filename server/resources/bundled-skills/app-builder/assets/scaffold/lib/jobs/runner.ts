import { getDatabase } from "@/lib/db/client";

type RunnerState = {
  timer: NodeJS.Timeout | null;
  ticking: boolean;
};

const globalState = globalThis as typeof globalThis & {
  __rudderAppJobRunner?: RunnerState;
};

function state(): RunnerState {
  globalState.__rudderAppJobRunner ??= { timer: null, ticking: false };
  return globalState.__rudderAppJobRunner;
}

async function tick() {
  const current = state();
  if (current.ticking) return;
  current.ticking = true;
  try {
    const { sqlite } = getDatabase();
    const now = Date.now();
    sqlite.prepare(`
      update jobs
      set status = case catch_up_policy
        when 'skip' then 'missed'
        when 'run' then 'pending'
        else 'missed'
      end,
      updated_at = ?
      where status = 'pending' and scheduled_for < ?
    `).run(now, now - 60_000);
    // Domain-specific handlers should claim one pending job transactionally,
    // execute it with the persisted idempotency key, and then complete/fail it.
  } catch {
    // The health endpoint remains authoritative. A missing pre-migration table
    // must not create an unhandled background rejection during startup.
  } finally {
    current.ticking = false;
  }
}

export function startJobRunner() {
  const current = state();
  if (current.timer) return;
  current.timer = setInterval(() => void tick(), 15_000);
  current.timer.unref();
  void tick();
}

export function stopJobRunner() {
  const current = state();
  if (current.timer) clearInterval(current.timer);
  current.timer = null;
}
