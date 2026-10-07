export type NamedTargetRuntime = {
  getName(targetId: string): Promise<string>;
  setName(targetId: string, name: string): Promise<boolean>;
};

export type SimpleTitleRuntime = {
  getTitle(): Promise<string> | string;
  setTitle(title: string): Promise<boolean | void> | boolean | void;
};

export type TitleSpinnerRuntime = {
  getTitle(targetId: string): Promise<string>;
  setTitle(targetId: string, title: string): Promise<boolean>;
};

export type SpinnerConfig = {
  enabled: boolean;
  style: string;
  speed: string;
};

export const SPINNER_STYLES: Record<string, string[]> = {
  default: ["·", "✢", "✳", "✶", "✻", "✽"],
  braille: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  dots: ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"],
  classic: ["-", "\\", "|", "/"],
  arrows: ["←", "↖", "↑", "↗", "→", "↘", "↓", "↙"],
  pipe: ["┤", "┘", "┴", "└", "├", "┌", "┬", "┐"],
  star: ["✶", "✸", "✹", "✺", "✹", "✸"],
  moon: ["🌑", "🌒", "🌓", "🌔", "🌕", "🌖", "🌗", "🌘"],
  pulse: ["·", "•", "●", "•"],
};

export const SPINNER_SPEEDS: Record<string, number> = {
  slow: 300,
  normal: 150,
  fast: 80,
};

export function stripSpinnerPrefix(name: string, frame: string | null): string {
  if (!frame) return name;
  const prefix = `${frame} `;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

/**
 * Styles made of plain ASCII ("-", "\", ...). A real title can start with
 * those glyphs, so they are only stripped when the style is known to be the
 * one that produced the prefix.
 */
const AMBIGUOUS_STYLES = new Set(["classic"]);

const UNAMBIGUOUS_STYLE_NAMES = Object.keys(SPINNER_STYLES).filter((style) => !AMBIGUOUS_STYLES.has(style));

/**
 * Strip leading "<frame> " decorations for the given styles, repeating until
 * none match so stacked duplicates left by a failed cleanup are removed too.
 * Defaults to styles whose glyphs cannot be mistaken for real title text.
 */
export function stripSpinnerFrames(name: string, styles: readonly string[] = UNAMBIGUOUS_STYLE_NAMES): string {
  const frames = styles.flatMap((style) => SPINNER_STYLES[style] ?? []);
  let current = name;
  for (;;) {
    const frame = frames.find((candidate) => current.startsWith(`${candidate} `));
    if (!frame) return current;
    current = current.slice(frame.length + 1);
  }
}

export function createTitleSpinner(runtime: TitleSpinnerRuntime, config: SpinnerConfig) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let frameIndex = 0;
  let running = false;
  let lastFrame: string | null = null;
  let activeTargetId: string | undefined;
  let tickInFlight: Promise<void> | null = null;
  let stopInFlight: Promise<void> | null = null;

  const scheduleTick = (): void => {
    const ms = SPINNER_SPEEDS[config.speed] ?? SPINNER_SPEEDS.normal;
    timer = setTimeout(() => {
      void startTick();
    }, ms);
  };

  const tick = async (): Promise<void> => {
    const targetId = activeTargetId;
    if (!running || !targetId) return;

    const frames = SPINNER_STYLES[config.style] ?? SPINNER_STYLES.default;
    const frame = frames[frameIndex % frames.length] ?? "·";
    frameIndex += 1;

    const current = await runtime.getTitle(targetId);
    if (!running || activeTargetId !== targetId) return;

    // On the first tick there is no remembered frame, so any decoration still
    // present is stale (e.g. left by a killed run): strip it before painting.
    const base = lastFrame ? stripSpinnerPrefix(current, lastFrame) : stripSpinnerFrames(current);
    await runtime.setTitle(targetId, `${frame} ${base}`);
    lastFrame = frame;

    if (running && activeTargetId === targetId) {
      scheduleTick();
    }
  };

  const startTick = (): Promise<void> => {
    const work = tick().finally(() => {
      if (tickInFlight === work) {
        tickInFlight = null;
      }
    });
    tickInFlight = work;
    return work;
  };

  const stop = async (): Promise<void> => {
    running = false;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }

    const targetId = activeTargetId;
    const inFlight = tickInFlight;
    if (inFlight) await inFlight;

    activeTargetId = undefined;
    frameIndex = 0;
    const frameToStrip = lastFrame;
    lastFrame = null;

    if (!targetId || !frameToStrip) return;

    // Cleanup is best effort: a lost rename must not reject the caller's event
    // chain, and a desynced remembered frame must not leave decorations behind.
    try {
      const current = await runtime.getTitle(targetId);
      const restored = stripSpinnerFrames(stripSpinnerPrefix(current, frameToStrip), [
        config.style,
        ...UNAMBIGUOUS_STYLE_NAMES,
      ]);
      if (restored !== current) {
        await runtime.setTitle(targetId, restored);
      }
    } catch {
      // The next agent_start reconciles against the real title.
    }
  };

  return {
    async start(targetId: string): Promise<void> {
      if (!config.enabled || running) return;
      if (stopInFlight) await stopInFlight;
      if (running) return;

      activeTargetId = targetId;
      running = true;
      frameIndex = 0;
      await startTick();
    },

    async stop(): Promise<void> {
      if (stopInFlight) return stopInFlight;

      const work = stop().finally(() => {
        if (stopInFlight === work) {
          stopInFlight = null;
        }
      });
      stopInFlight = work;
      return work;
    },
  };
}

export function createNamedTargetSpinner(runtime: NamedTargetRuntime, config: SpinnerConfig) {
  return createTitleSpinner(
    {
      getTitle(targetId) {
        return runtime.getName(targetId);
      },
      setTitle(targetId, title) {
        return runtime.setName(targetId, title);
      },
    },
    config,
  );
}

export function createSimpleSpinner(runtime: SimpleTitleRuntime, config: SpinnerConfig) {
  const spinner = createTitleSpinner(
    {
      async getTitle() {
        return runtime.getTitle();
      },
      async setTitle(_targetId, title) {
        const result = await runtime.setTitle(title);
        return result !== false;
      },
    },
    config,
  );

  return {
    start(): Promise<void> {
      return spinner.start("simple-title");
    },
    stop(): Promise<void> {
      return spinner.stop();
    },
  };
}
