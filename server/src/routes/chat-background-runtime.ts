import { logger } from "../middleware/logger.js";

export type ChatBackgroundTimer = ReturnType<typeof setTimeout>;

export interface ChatBackgroundTask {
  wake(): void;
}

export interface ChatBackgroundRuntime {
  readonly acceptingWork: boolean;
  setTimeout(task: () => void | Promise<void>, delayMs: number): ChatBackgroundTimer | null;
  setInterval(task: () => void | Promise<void>, intervalMs: number): ChatBackgroundTimer | null;
  clearTimer(timer: ChatBackgroundTimer | null): void;
  createCoalescingTask(
    task: () => Promise<void>,
    onError: (error: unknown) => void,
  ): ChatBackgroundTask;
  track<T>(work: Promise<T>): Promise<T>;
  manageAbortController(controller?: AbortController): {
    controller: AbortController;
    release(): void;
  };
  close(): Promise<void>;
}

export function createChatBackgroundRuntime(): ChatBackgroundRuntime {
  const timers = new Set<ChatBackgroundTimer>();
  const inFlight = new Set<Promise<unknown>>();
  const abortControllers = new Set<AbortController>();
  let acceptingWork = true;
  let closeInFlight: Promise<void> | null = null;

  function track<T>(work: Promise<T>): Promise<T> {
    inFlight.add(work);
    void work.then(
      () => inFlight.delete(work),
      () => inFlight.delete(work),
    );
    return work;
  }

  function runScheduledTask(task: () => void | Promise<void>) {
    if (!acceptingWork) return;
    const work = Promise.resolve().then(() => {
      if (!acceptingWork) return;
      return task();
    });
    void track(work).catch((error) => {
      logger.warn({ err: error }, "chat background runtime task failed");
    });
  }

  function scheduleTimeout(task: () => void | Promise<void>, delayMs: number) {
    if (!acceptingWork) return null;
    let timer: ChatBackgroundTimer;
    timer = setTimeout(() => {
      timers.delete(timer);
      runScheduledTask(task);
    }, delayMs);
    timer.unref?.();
    timers.add(timer);
    return timer;
  }

  function scheduleInterval(task: () => void | Promise<void>, intervalMs: number) {
    if (!acceptingWork) return null;
    const timer = setInterval(() => runScheduledTask(task), intervalMs);
    timer.unref?.();
    timers.add(timer);
    return timer;
  }

  function clearTimer(timer: ChatBackgroundTimer | null) {
    if (!timer) return;
    clearTimeout(timer);
    clearInterval(timer);
    timers.delete(timer);
  }

  function createCoalescingTask(
    task: () => Promise<void>,
    onError: (error: unknown) => void,
  ): ChatBackgroundTask {
    let scheduled = false;
    let running = false;
    let requested = false;

    const wake = () => {
      if (!acceptingWork) return;
      if (scheduled || running) {
        requested = true;
        return;
      }
      scheduled = true;
      scheduleTimeout(() => {
        scheduled = false;
        if (!acceptingWork || running) return;
        running = true;
        return task()
          .catch(onError)
          .finally(() => {
            running = false;
            if (requested) {
              requested = false;
              wake();
            }
          });
      }, 0);
    };

    return { wake };
  }

  function manageAbortController(controller = new AbortController()) {
    if (!acceptingWork) {
      controller.abort(new Error("Chat background runtime is closing"));
      return { controller, release: () => undefined };
    }
    abortControllers.add(controller);
    let released = false;
    return {
      controller,
      release() {
        if (released) return;
        released = true;
        abortControllers.delete(controller);
      },
    };
  }

  function close() {
    if (closeInFlight) return closeInFlight;
    acceptingWork = false;
    for (const timer of timers) clearTimer(timer);
    for (const controller of abortControllers) {
      controller.abort(new Error("Chat background runtime is closing"));
    }
    abortControllers.clear();

    closeInFlight = Promise.resolve().then(async () => {
      while (inFlight.size > 0) {
        await Promise.allSettled([...inFlight]);
      }
    });
    return closeInFlight;
  }

  return {
    get acceptingWork() {
      return acceptingWork;
    },
    setTimeout: scheduleTimeout,
    setInterval: scheduleInterval,
    clearTimer,
    createCoalescingTask,
    track,
    manageAbortController,
    close,
  };
}
