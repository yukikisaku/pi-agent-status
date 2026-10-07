import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type TmuxExecResult = {
  code: number;
  stdout?: string;
  stderr?: string;
};

export type TmuxExec = (command: string, args: string[]) => Promise<TmuxExecResult>;

const WORKING_WINDOW_OPTION = "@pi-tmux-working";

export type TmuxRuntime = {
  isAvailable(): boolean;
  resolveSessionId(): Promise<string | undefined>;
  resolveWindowId(): Promise<string | undefined>;
  getName(windowId: string): Promise<string>;
  setName(windowId: string, name: string): Promise<boolean>;
  setWindowWorking(windowId: string, working: boolean): Promise<boolean>;
  hasWorkingWindowInSession(sessionId?: string): Promise<boolean>;
  isTargetVisible(windowId: string): Promise<boolean>;
  isAppFocused(): Promise<boolean>;
  installClearAlertHooks(mark: string, focusedMarkAutoClearMs: number): Promise<boolean>;
};

function normalizeTarget(value: string | undefined): string | undefined {
  const target = value?.trim();
  return target || undefined;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function clearAlertScript(mark: string, targetExpression: string, windowNameFormat: string): string {
  const markWithSpace = `${mark.trim()} `;
  return [
    `name=$(tmux display-message -p -t ${targetExpression} ${shellSingleQuote(windowNameFormat)})`,
    `mark=${shellSingleQuote(markWithSpace)}`,
    `case "$name" in "$mark"*) tmux rename-window -t ${targetExpression} "${"${name#\"$mark\"}"}" ;; esac`,
  ].join("; ");
}

export function buildClearAlertHookCommand(mark: string): string {
  return `run-shell -b ${shellSingleQuote(clearAlertScript(mark, shellSingleQuote("#{window_id}"), "#{window_name}"))}`;
}

export function buildDelayedClearAlertHookCommand(mark: string, delayMs: number): string {
  const delaySeconds = Math.max(0, delayMs) / 1000;
  const script = [
    `window_id=${shellSingleQuote("#{window_id}")}`,
    `sleep ${delaySeconds}`,
    clearAlertScript(mark, '"$window_id"', "##{window_name}"),
  ].join("; ");

  return `run-shell -b ${shellSingleQuote(script)}`;
}

export function createTmuxRuntime(exec: TmuxExec, env: NodeJS.ProcessEnv = process.env): TmuxRuntime {
  const runTmux = async (args: string[]): Promise<TmuxExecResult> => {
    try {
      return await exec("tmux", args);
    } catch (error) {
      return { code: 1, stderr: error instanceof Error ? error.message : String(error) };
    }
  };

  return {
    isAvailable(): boolean {
      return !!env.TMUX && !!env.TMUX_PANE;
    },

    async resolveSessionId(): Promise<string | undefined> {
      if (!this.isAvailable()) return undefined;

      const pane = normalizeTarget(env.TMUX_PANE);
      if (!pane) return undefined;

      const result = await runTmux(["display-message", "-p", "-t", pane, "#{session_id}"]);
      if (result.code !== 0) return undefined;
      return normalizeTarget(result.stdout);
    },

    async resolveWindowId(): Promise<string | undefined> {
      if (!this.isAvailable()) return undefined;

      const pane = normalizeTarget(env.TMUX_PANE);
      if (!pane) return undefined;

      const result = await runTmux(["display-message", "-p", "-t", pane, "#{window_id}"]);
      if (result.code !== 0) return undefined;
      return normalizeTarget(result.stdout);
    },

    async getName(windowId: string): Promise<string> {
      const result = await runTmux(["display-message", "-p", "-t", windowId, "#{window_name}"]);
      return result.code === 0 ? (result.stdout ?? "").trim() : "";
    },

    async setName(windowId: string, name: string): Promise<boolean> {
      const result = await runTmux(["rename-window", "-t", windowId, name]);
      return result.code === 0;
    },

    async setWindowWorking(windowId: string, working: boolean): Promise<boolean> {
      if (!this.isAvailable()) return false;

      const target = normalizeTarget(windowId);
      if (!target) return false;

      const result = await runTmux([
        "set-window-option",
        "-t",
        target,
        WORKING_WINDOW_OPTION,
        working ? "1" : "0",
      ]);
      return result.code === 0;
    },

    async hasWorkingWindowInSession(sessionId?: string): Promise<boolean> {
      if (!this.isAvailable()) return false;

      const target = normalizeTarget(sessionId) ?? (await this.resolveSessionId());
      if (!target) return false;

      const result = await runTmux([
        "list-windows",
        "-t",
        target,
        "-F",
        `#{window_id}\t#{${WORKING_WINDOW_OPTION}}`,
      ]);
      if (result.code !== 0) return false;

      return (result.stdout ?? "").split(/\r?\n/).some((line) => line.split("\t")[1]?.trim() === "1");
    },

    async isTargetVisible(windowId: string): Promise<boolean> {
      const result = await runTmux(["display-message", "-p", "-t", windowId, "#{window_active}"]);
      return result.code === 0 && (result.stdout ?? "").trim() === "1";
    },

    async isAppFocused(): Promise<boolean> {
      const result = await runTmux(["display-message", "-p", "#{client_flags}"]);
      if (result.code !== 0) return true;

      const flags = (result.stdout ?? "").split(",").map((flag) => flag.trim()).filter(Boolean);
      if (flags.length === 0) return true;
      return flags.includes("focused");
    },

    async installClearAlertHooks(mark: string, focusedMarkAutoClearMs: number): Promise<boolean> {
      if (!this.isAvailable()) return false;

      await runTmux(["set-option", "-g", "focus-events", "on"]);
      await runTmux(["set-hook", "-gu", "client-session-changed[900]"]);

      const delayedClearCommand = buildDelayedClearAlertHookCommand(mark, focusedMarkAutoClearMs);
      const hooks = [
        ["after-select-window[900]", buildClearAlertHookCommand(mark)],
        ["after-select-window[901]", buildDelayedClearAlertHookCommand(mark, 250)],
        ["client-focus-in[900]", delayedClearCommand],
        ["client-active[900]", delayedClearCommand],
      ] as const;
      const results = await Promise.all(hooks.map(([hook, command]) => runTmux(["set-hook", "-g", hook, command])));
      return results.every((result) => result.code === 0);
    },
  };
}

export function createPiTmuxRuntime(pi: ExtensionAPI): TmuxRuntime {
  return createTmuxRuntime((command, args) => pi.exec(command, args));
}
