export type AlertRuntime = {
  getName(targetId: string): Promise<string>;
  setName(targetId: string, name: string): Promise<boolean>;
  /** tmux: window is the active one. Herdr: tab is the focused one. */
  isTargetVisible(targetId: string): Promise<boolean>;
  /** tmux: the attached client has focus. Hosts without such a notion return true. */
  isAppFocused(): Promise<boolean>;
};

export type CompletionAlertOptions = {
  enabled: boolean;
  bellEnabled: boolean;
  directSoundEnabled?: boolean;
  focusedMarkAutoClearMs?: number;
  markWatchIntervalMs?: number;
  markWatchMaxMs?: number;
  mark: string;
  ringBell: () => void;
  playDirectSound?: () => void;
  scheduleAutoClear?: (callback: () => Promise<void>, delayMs: number) => void;
  watchMarkedTarget?: (
    callback: () => Promise<boolean>,
    intervalMs: number,
    maxMs: number,
    targetId: string,
  ) => void;
};

const DEFAULT_MARK_WATCH_INTERVAL_MS = 500;
const DEFAULT_MARK_WATCH_MAX_MS = 30 * 60 * 1000;
const activeMarkWatchers = new Map<string, ReturnType<typeof setInterval>>();

function alertPrefix(mark: string): string {
  return `${mark.trim()} `;
}

export function stripCompletionMark(name: string, mark: string): string {
  const prefix = alertPrefix(mark);
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

export function addCompletionMark(name: string, mark: string): string {
  const clean = stripCompletionMark(name, mark).trim();
  return `${alertPrefix(mark)}${clean}`.trim();
}

function defaultWatchMarkedTarget(
  callback: () => Promise<boolean>,
  intervalMs: number,
  maxMs: number,
  targetId: string,
): void {
  const existing = activeMarkWatchers.get(targetId);
  if (existing) {
    clearInterval(existing);
  }

  const startedAt = Date.now();
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;

    void callback()
      .then((done) => {
        if (done || Date.now() - startedAt >= maxMs) {
          clearInterval(timer);
          if (activeMarkWatchers.get(targetId) === timer) {
            activeMarkWatchers.delete(targetId);
          }
        }
      })
      .catch(() => {
        clearInterval(timer);
        if (activeMarkWatchers.get(targetId) === timer) {
          activeMarkWatchers.delete(targetId);
        }
      })
      .finally(() => {
        inFlight = false;
      });
  }, intervalMs);

  timer.unref?.();
  activeMarkWatchers.set(targetId, timer);
}

export function createCompletionAlert(runtime: AlertRuntime, options: CompletionAlertOptions) {
  const scheduleAutoClear =
    options.scheduleAutoClear ??
    ((callback: () => Promise<void>, delayMs: number) => {
      setTimeout(() => {
        void callback();
      }, delayMs).unref?.();
    });

  const clearMarkIfPresent = async (targetId: string): Promise<boolean> => {
    const marked = await runtime.getName(targetId);
    if (!marked) return true;

    const clean = stripCompletionMark(marked, options.mark);
    if (clean === marked) return true;

    await runtime.setName(targetId, clean);
    return true;
  };

  const scheduleFocusedAutoClear = (targetId: string, delayMs: number): void => {
    if (delayMs <= 0) return;
    scheduleAutoClear(async () => {
      await clearMarkIfPresent(targetId);
    }, delayMs);
  };

  const watchMarkedTarget = (callback: () => Promise<boolean>, targetId: string): void => {
    const watch = options.watchMarkedTarget ?? defaultWatchMarkedTarget;
    watch(
      callback,
      options.markWatchIntervalMs ?? DEFAULT_MARK_WATCH_INTERVAL_MS,
      options.markWatchMaxMs ?? DEFAULT_MARK_WATCH_MAX_MS,
      targetId,
    );
  };

  return {
    async prepareForAgentStart(targetId: string): Promise<void> {
      if (!options.enabled) return;
      const current = await runtime.getName(targetId);
      const clean = stripCompletionMark(current, options.mark);
      if (clean !== current) {
        await runtime.setName(targetId, clean);
      }
    },

    async notifyAgentEnd(targetId: string): Promise<void> {
      if (options.bellEnabled) {
        options.ringBell();
      }

      if (!options.enabled) return;

      const targetVisible = await runtime.isTargetVisible(targetId);
      const appFocused = await runtime.isAppFocused();

      if (!targetVisible && options.directSoundEnabled && appFocused) {
        options.playDirectSound?.();
      }

      const current = await runtime.getName(targetId);
      // A failed lookup must not replace an unknown title with just the mark.
      if (!current.trim()) return;
      if (!(await runtime.setName(targetId, addCompletionMark(current, options.mark)))) return;

      const autoClearMs = options.focusedMarkAutoClearMs ?? 0;
      if (targetVisible && appFocused) {
        scheduleFocusedAutoClear(targetId, autoClearMs);
        return;
      }

      if (!targetVisible) {
        watchMarkedTarget(async () => {
          const name = await runtime.getName(targetId);
          if (!name || !name.startsWith(alertPrefix(options.mark))) return true;
          if (!(await runtime.isTargetVisible(targetId))) return false;

          await clearMarkIfPresent(targetId);
          return true;
        }, targetId);
        return;
      }

      watchMarkedTarget(async () => {
        const name = await runtime.getName(targetId);
        if (!name || !name.startsWith(alertPrefix(options.mark))) return true;
        if (!(await runtime.isAppFocused())) return false;

        scheduleFocusedAutoClear(targetId, autoClearMs);
        return true;
      }, targetId);
    },
  };
}
