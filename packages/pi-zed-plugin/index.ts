import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";

import {
  compactTitle,
  createSettingsCommand,
  createSimpleSpinner,
  createTerminalTitleRuntime,
  createTitleController,
  getFirstUserPrompt,
  installTitleSuffixStripper,
  isMainAgentSession,
  ringTerminalBell,
  setTerminalTitle,
  SPINNER_SPEEDS,
  SPINNER_STYLES,
} from "./core/index.ts";
import { loadSettings, saveSettings, type PiZedSettings } from "./settings.ts";

// tmux rewrites TERM_PROGRAM, so inside tmux this extension always stands down
// and leaves the terminal title to a tmux-aware extension.
export function isZedTerminal(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.TMUX) return false;
  return env.TERM_PROGRAM === "zed" || env.ZED_TERM === "true";
}

export default function piZedExtension(pi: ExtensionAPI) {
  if (!isZedTerminal()) return;

  let settings: PiZedSettings = loadSettings();
  let spinner: ReturnType<typeof createSimpleSpinner> | null = null;

  const stopSpinner = async (): Promise<void> => {
    const stopping = spinner?.stop();
    spinner = null;
    if (stopping) await stopping;
  };

  const title = createTitleController({
    pi,
    getNaming: () => settings.naming,
    applyTitle(rawTitle) {
      const normalized = compactTitle(rawTitle, settings.naming.maxChars);
      if (!normalized) return undefined;

      pi.setSessionName(normalized);
      setTerminalTitle(normalized);
      return normalized;
    },
  });

  const settingsCommand = createSettingsCommand({
    name: "pi-zed-plugin",
    save: () => saveSettings(settings),
    async onChange(key) {
      if (key === "spinner" && !settings.spinner.enabled) {
        await stopSpinner();
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
        key: "bell",
        type: "boolean",
        get: () => settings.bell.enabled,
        set: (value) => {
          settings.bell.enabled = value;
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
    description: "Rename the Zed terminal tab title from the conversation or an explicit title",
    handler: (args: string, ctx: ExtensionCommandContext) => title.renameCommand(args, ctx),
  });

  pi.registerCommand("pi-zed-plugin", {
    description: "Configure the Zed terminal spinner, completion bell, and title naming",
    handler: settingsCommand,
  });

  pi.on("session_start", async (_event, ctx) => {
    if (!isMainAgentSession(ctx)) return;

    installTitleSuffixStripper(basename(ctx.sessionManager.getCwd()));

    await stopSpinner();
    title.reset();
    settings = loadSettings();

    if (!(await title.restoreExistingTitle(ctx))) {
      setTerminalTitle(basename(ctx.sessionManager.getCwd()));
    }
  });

  pi.on("before_agent_start", async (event, ctx: ExtensionContext) => {
    if (!isMainAgentSession(ctx)) return;

    const firstPrompt = getFirstUserPrompt(ctx.sessionManager.getBranch()) ?? event.prompt;
    void title.applyAutoTitle(firstPrompt, ctx);
  });

  pi.on("agent_start", async (_event, ctx) => {
    if (!isMainAgentSession(ctx)) return;

    await stopSpinner();

    const baseTitle = pi.getSessionName() ?? basename(ctx.sessionManager.getCwd());
    spinner = createSimpleSpinner(createTerminalTitleRuntime(baseTitle), settings.spinner);
    await spinner.start();
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!isMainAgentSession(ctx)) return;

    await stopSpinner();

    // Zed raises its own "task finished" notification when an unfocused terminal rings.
    if (settings.bell.enabled) {
      ringTerminalBell();
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (!isMainAgentSession(ctx)) return;
    await stopSpinner();
  });
}
