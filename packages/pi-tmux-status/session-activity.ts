import {
  createSimpleSpinner,
  type SimpleTitleRuntime,
  type SpinnerConfig,
} from "./core/index.ts";
import type { TmuxRuntime } from "./tmux-runtime.ts";

const DEFAULT_POLL_INTERVAL_MS = 500;

export type TmuxSessionActivityMonitor = {
  start(): Promise<void>;
  stop(): Promise<void>;
  sync(): Promise<void>;
};

/**
 * Spins the outer terminal title while any window of the tmux session is busy,
 * so a collapsed tmux session still shows activity in the host terminal's tab.
 */
export function createTmuxSessionActivityMonitor(
  tmux: Pick<TmuxRuntime, "hasWorkingWindowInSession">,
  terminalRuntime: SimpleTitleRuntime,
  config: SpinnerConfig,
  options: { pollIntervalMs?: number } = {},
): TmuxSessionActivityMonitor {
  const spinner = createSimpleSpinner(terminalRuntime, config);
  const pollIntervalMs = Math.max(50, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);

  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let spinnerActive = false;
  let syncInFlight: Promise<void> | null = null;
  let needsSync = false;

  const clearTimer = (): void => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  const syncNow = async (): Promise<void> => {
    const shouldSpin = config.enabled && (await tmux.hasWorkingWindowInSession());
    if (!running || !config.enabled) return;

    if (shouldSpin && !spinnerActive) {
      spinnerActive = true;
      await spinner.start();
      if (!running || !config.enabled) {
        await spinner.stop();
        spinnerActive = false;
      }
      return;
    }

    if (!shouldSpin && spinnerActive) {
      await spinner.stop();
      spinnerActive = false;
    }
  };

  const sync = async (): Promise<void> => {
    if (syncInFlight) {
      needsSync = true;
      return syncInFlight;
    }

    const work = (async () => {
      do {
        needsSync = false;
        await syncNow();
      } while (needsSync && running);
    })().finally(() => {
      if (syncInFlight === work) {
        syncInFlight = null;
      }
    });

    syncInFlight = work;
    return work;
  };

  const schedule = (): void => {
    if (!running || timer !== null) return;

    timer = setTimeout(() => {
      timer = null;
      void sync().catch(() => {}).finally(schedule);
    }, pollIntervalMs);
  };

  return {
    async start(): Promise<void> {
      if (running || !config.enabled) return;

      running = true;
      await sync();
      schedule();
    },

    async stop(): Promise<void> {
      running = false;
      clearTimer();
      needsSync = false;

      if (syncInFlight) {
        await syncInFlight;
      }

      if (spinnerActive) {
        await spinner.stop();
        spinnerActive = false;
      }
    },

    sync,
  };
}
