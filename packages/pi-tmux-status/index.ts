import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";

import {
  compactTitle,
  createCompletionAlert,
  createNamedTargetSpinner,
  createSettingsCommand,
  createTerminalTitleRuntime,
  createTitleController,
  getFirstUserPrompt,
  installTitleSuffixStripper,
  isMainAgentSession,
  setTerminalTitle,
  SPINNER_SPEEDS,
  SPINNER_STYLES,
  type AnyContext,
} from "./core/index.ts";
import { createTmuxSessionActivityMonitor, type TmuxSessionActivityMonitor } from "./session-activity.ts";
import { createPiTmuxRuntime } from "./tmux-runtime.ts";
import { loadSettings, saveSettings, type PiTmuxSettings } from "./settings.ts";

function ringBell(): void {
  if (process.stderr.isTTY) {
    process.stderr.write("\x07");
  }
}

export default function piTmuxExtension(pi: ExtensionAPI) {
  const tmux = createPiTmuxRuntime(pi);
  if (!tmux.isAvailable()) return;

  let settings: PiTmuxSettings = loadSettings();
  let windowId: string | undefined;
  let windowIdInFlight: Promise<string | undefined> | null = null;
  let windowSpinner: ReturnType<typeof createNamedTargetSpinner> | null = null;
  let activityMonitor: TmuxSessionActivityMonitor | null = null;

  const playCompletionSound = () => {
    if (!settings.sound.enabled) return;
    const command = settings.sound.command.trim();
    if (!command) return;

    void pi.exec(command, settings.sound.args).catch(() => {
      // A missing sound player must not break the agent lifecycle.
    });
  };

  const captureWindowId = async (): Promise<string | undefined> => {
    if (windowId) return windowId;
    if (windowIdInFlight) return windowIdInFlight;

    const work = tmux
      .resolveWindowId()
      .then((target) => {
        windowId = target;
        return target;
      })
      .finally(() => {
        if (windowIdInFlight === work) {
          windowIdInFlight = null;
        }
      });

    windowIdInFlight = work;
    return work;
  };

  const stopWindowSpinner = async (): Promise<void> => {
    const stopping = windowSpinner?.stop();
    windowSpinner = null;
    if (stopping) await stopping;
  };

  const stopActivityMonitor = async (): Promise<void> => {
    const stopping = activityMonitor?.stop();
    activityMonitor = null;
    if (stopping) await stopping;
  };

  const startActivityMonitor = async (ctx: AnyContext): Promise<void> => {
    if (activityMonitor || !settings.spinner.enabled) return;

    const baseTitle = pi.getSessionName() ?? basename(ctx.sessionManager.getCwd());
    activityMonitor = createTmuxSessionActivityMonitor(
      tmux,
      createTerminalTitleRuntime(baseTitle),
      settings.spinner,
    );
    await activityMonitor.start();
  };

  const installAlertHooks = async (): Promise<void> => {
    if (!settings.completionAlert.enabled || !settings.completionAlert.hookEnabled) return;
    await tmux.installClearAlertHooks(
      settings.completionAlert.mark,
      settings.completionAlert.focusedMarkAutoClearMs,
    );
  };

  const title = createTitleController({
    pi,
    getNaming: () => settings.naming,
    async applyTitle(rawTitle) {
      const normalized = compactTitle(rawTitle, settings.naming.maxChars);
      if (!normalized) return undefined;

      pi.setSessionName(normalized);
      setTerminalTitle(normalized);

      const target = await captureWindowId();
      if (target) {
        await tmux.setName(target, normalized);
      }

      return normalized;
    },
    // External renames (pi /name, Oh My Pi's builtin /rename) already own the
    // session name; mirror them onto the tab without writing back. An unknown
    // window id cannot retry meaningfully, so that push claims success; a
    // failed tmux rename stays unclaimed so the watcher retries.
    async pushTabTitle(normalizedTitle) {
      setTerminalTitle(normalizedTitle);

      const target = await captureWindowId();
      if (!target) return normalizedTitle;
      return (await tmux.setName(target, normalizedTitle)) ? normalizedTitle : undefined;
    },
  });

  const settingsCommand = createSettingsCommand({
    name: "pi-tmux",
    save: () => saveSettings(settings),
    async onChange(key, ctx) {
      if (key === "spinner" || key === "style" || key === "speed") {
        await stopActivityMonitor();
        if (!settings.spinner.enabled) await stopWindowSpinner();
        await startActivityMonitor(ctx);
        return;
      }
      if (key === "alert" || key === "mark") {
        await installAlertHooks();
      }
    },
    specs: [
      {
        key: "spinner",
        type: "boolean",
        get: () => settings.spinner.enabled,
        set: (value) => {
          settings.spinner.enabled = value;
        },
      },
      {
        key: "style",
        type: "enum",
        values: Object.keys(SPINNER_STYLES),
        describe: (value) => SPINNER_STYLES[value]!.join(" "),
        get: () => settings.spinner.style,
        set: (value) => {
          settings.spinner.style = value;
        },
      },
      {
        key: "speed",
        type: "enum",
        values: Object.keys(SPINNER_SPEEDS),
        describe: (value) => `${SPINNER_SPEEDS[value]}ms`,
        get: () => settings.spinner.speed,
        set: (value) => {
          settings.spinner.speed = value;
        },
      },
      {
        key: "alert",
        type: "boolean",
        get: () => settings.completionAlert.enabled,
        set: (value) => {
          settings.completionAlert.enabled = value;
        },
      },
      {
        key: "mark",
        type: "string",
        get: () => settings.completionAlert.mark,
        set: (value) => {
          settings.completionAlert.mark = value;
        },
      },
      {
        key: "bell",
        type: "boolean",
        get: () => settings.completionAlert.bellEnabled,
        set: (value) => {
          settings.completionAlert.bellEnabled = value;
        },
      },
      {
        key: "sound",
        type: "boolean",
        get: () => settings.sound.enabled,
        set: (value) => {
          settings.sound.enabled = value;
        },
      },
      {
        key: "naming",
        type: "boolean",
        get: () => settings.naming.enabled,
        set: (value) => {
          settings.naming.enabled = value;
        },
      },
      {
        key: "naming-model",
        type: "string",
        allowEmpty: true,
        emptyValueLabel: "(current session model)",
        get: () => settings.naming.model,
        set: (value) => {
          settings.naming.model = value;
        },
      },
    ],
  });

  pi.registerCommand("rename", {
    description: "Rename the tmux window and session title from the conversation or an explicit title",
    handler: (args: string, ctx: ExtensionCommandContext) => title.renameCommand(args, ctx),
  });

  pi.registerCommand("pi-tmux", {
    description: "Configure the tmux spinner, completion alert, and title naming",
    handler: settingsCommand,
  });

  // Plain Pi announces every session rename (/name, other extensions) through
  // this event; Oh My Pi exposes no rename event, so there the session-name
  // watcher started below is what keeps the window title in sync.
  pi.on("session_info_changed", async (event, ctx) => {
    if (!isMainAgentSession(ctx)) return;
    await title.applyExternalTitle(event.name, ctx);
  });

  pi.on("session_start", async (_event, ctx) => {
    if (!isMainAgentSession(ctx)) return;

    installTitleSuffixStripper(basename(ctx.sessionManager.getCwd()));

    await stopWindowSpinner();
    await stopActivityMonitor();
    title.reset();
    windowId = undefined;
    windowIdInFlight = null;
    settings = loadSettings();
    await installAlertHooks();

    const target = await captureWindowId();
    if (target) {
      await tmux.setWindowWorking(target, false);
    }

    await title.restoreExistingTitle(ctx);
    title.startSessionNameWatch(ctx);
    await startActivityMonitor(ctx);
  });

  pi.on("before_agent_start", async (event, ctx: ExtensionContext) => {
    if (!isMainAgentSession(ctx)) return;

    const firstPrompt = getFirstUserPrompt(ctx.sessionManager.getBranch(), event.prompt);
    void title.applyAutoTitle(firstPrompt, ctx);
  });

  pi.on("agent_start", async (_event, ctx) => {
    if (!isMainAgentSession(ctx)) return;

    await stopWindowSpinner();

    const target = await captureWindowId();
    if (!target) return;

    await startActivityMonitor(ctx);
    await tmux.setWindowWorking(target, true);
    await activityMonitor?.sync();

    const alert = createCompletionAlert(tmux, {
      enabled: settings.completionAlert.enabled,
      bellEnabled: false,
      mark: settings.completionAlert.mark,
      ringBell,
    });
    await alert.prepareForAgentStart(target);

    windowSpinner = createNamedTargetSpinner(tmux, settings.spinner);
    await windowSpinner.start(target);
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!isMainAgentSession(ctx)) return;

    await stopWindowSpinner();

    const target = await captureWindowId();
    if (!target) return;

    await tmux.setWindowWorking(target, false);
    await startActivityMonitor(ctx);
    await activityMonitor?.sync();

    const alert = createCompletionAlert(tmux, {
      enabled: settings.completionAlert.enabled,
      bellEnabled: settings.completionAlert.bellEnabled,
      directSoundEnabled: settings.sound.enabled,
      focusedMarkAutoClearMs: settings.completionAlert.focusedMarkAutoClearMs,
      markWatchIntervalMs: settings.completionAlert.markWatchIntervalMs,
      markWatchMaxMs: settings.completionAlert.markWatchMaxMs,
      mark: settings.completionAlert.mark,
      ringBell,
      playDirectSound: playCompletionSound,
    });
    await alert.notifyAgentEnd(target);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (!isMainAgentSession(ctx)) return;
    title.stopSessionNameWatch();

    const target = await captureWindowId();
    if (target) {
      await tmux.setWindowWorking(target, false);
    }

    await stopWindowSpinner();
    await stopActivityMonitor();
  });
}
