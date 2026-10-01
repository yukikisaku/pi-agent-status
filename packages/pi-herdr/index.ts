import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  compactTitle,
  createCompletionAlert,
  createNamedTargetSpinner,
  createSettingsCommand,
  createTitleController,
  getFirstUserPrompt,
  isMainAgentSession,
  setTerminalTitle,
  SPINNER_SPEEDS,
  SPINNER_STYLES,
} from "./core/index.ts";
import { createHerdrClient } from "./herdr-client.ts";
import { loadSettings, saveSettings, type PiHerdrSettings } from "./settings.ts";

export default function piHerdrExtension(pi: ExtensionAPI) {
  const herdr = createHerdrClient();
  const tabId = herdr.tabId();
  if (!herdr.isAvailable() || !tabId) return;

  let settings: PiHerdrSettings = loadSettings();
  let spinner: ReturnType<typeof createNamedTargetSpinner> | null = null;

  const stopSpinner = async (): Promise<void> => {
    const stopping = spinner?.stop();
    spinner = null;
    if (stopping) await stopping;
  };

  const title = createTitleController({
    pi,
    getNaming: () => settings.naming,
    async applyTitle(rawTitle) {
      const normalized = compactTitle(rawTitle, settings.naming.maxChars);
      if (!normalized) return undefined;

      pi.setSessionName(normalized);
      // Herdr reads the OSC title into its agent panel; the tab label is separate.
      setTerminalTitle(normalized);
      await herdr.setName(tabId, normalized);

      return normalized;
    },
  });

  const settingsCommand = createSettingsCommand({
    name: "pi-herdr",
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
    description: "Rename the Herdr tab label from the conversation or an explicit title",
    handler: (args: string, ctx: ExtensionCommandContext) => title.renameCommand(args, ctx),
  });

  pi.registerCommand("pi-herdr", {
    description: "Configure the Herdr tab spinner, completion mark, and title naming",
    handler: settingsCommand,
  });

  pi.on("session_start", async (_event, ctx) => {
    if (!isMainAgentSession(ctx)) return;

    await stopSpinner();
    title.reset();
    settings = loadSettings();
    await herdr.refresh(tabId);
    await title.restoreExistingTitle(ctx);
  });

  pi.on("before_agent_start", async (event, ctx: ExtensionContext) => {
    if (!isMainAgentSession(ctx)) return;

    const firstPrompt = getFirstUserPrompt(ctx.sessionManager.getBranch(), event.prompt);
    void title.applyAutoTitle(firstPrompt, ctx);
  });

  pi.on("agent_start", async (_event, ctx) => {
    if (!isMainAgentSession(ctx)) return;

    await stopSpinner();
    await herdr.refresh(tabId);

    const alert = createCompletionAlert(herdr, {
      enabled: settings.completionAlert.enabled,
      bellEnabled: false,
      mark: settings.completionAlert.mark,
      ringBell: () => {},
    });
    await alert.prepareForAgentStart(tabId);

    spinner = createNamedTargetSpinner(herdr, settings.spinner);
    await spinner.start(tabId);
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!isMainAgentSession(ctx)) return;

    await stopSpinner();

    const alert = createCompletionAlert(herdr, {
      enabled: settings.completionAlert.enabled,
      bellEnabled: settings.completionAlert.bellEnabled,
      focusedMarkAutoClearMs: settings.completionAlert.focusedMarkAutoClearMs,
      markWatchIntervalMs: settings.completionAlert.markWatchIntervalMs,
      markWatchMaxMs: settings.completionAlert.markWatchMaxMs,
      mark: settings.completionAlert.mark,
      ringBell: () => {
        if (process.stdout.isTTY) process.stdout.write("\x07");
      },
    });
    await alert.notifyAgentEnd(tabId);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (!isMainAgentSession(ctx)) return;
    await stopSpinner();
  });
}
