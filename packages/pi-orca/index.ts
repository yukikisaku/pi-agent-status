import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";

import {
  compactTitle,
  createCompletionAlert,
  createSettingsCommand,
  createTitleController,
  getFirstUserPrompt,
  isMainAgentSession,
  type AnyContext,
} from "./core/index.ts";
import { createPiOrcaRuntime } from "./orca-runtime.ts";
import { loadSettings, saveSettings, type PiOrcaSettings } from "./settings.ts";

export default function piOrcaExtension(pi: ExtensionAPI) {
  const orca = createPiOrcaRuntime(pi);
  if (!orca.isAvailable()) return;

  const terminalHandle = orca.terminalHandle();
  let settings: PiOrcaSettings = loadSettings();

  // Orca normalises Pi's OSC title to "Pi" for its own status display, so the tab
  // label has to be set through the CLI to survive.
  const renameOrcaTab = async (title: string): Promise<boolean> =>
    terminalHandle ? orca.setName(terminalHandle, title) : false;

  const applyFallbackTabTitle = (ctx: AnyContext, title: string): void => {
    if (!ctx.hasUI) return;
    const cwd = basename(ctx.sessionManager.getCwd()) || ctx.sessionManager.getCwd();
    ctx.ui.setTitle(`\u03c0 - ${title} - ${cwd}`);
  };

  const title = createTitleController({
    pi,
    getNaming: () => settings.naming,
    async applyTitle(rawTitle, ctx) {
      const normalized = compactTitle(rawTitle, settings.naming.maxChars);
      if (!normalized) return undefined;

      pi.setSessionName(normalized);
      if (!(await renameOrcaTab(normalized))) {
        applyFallbackTabTitle(ctx, normalized);
      }

      return normalized;
    },
  });

  const settingsCommand = createSettingsCommand({
    name: "pi-orca",
    save: () => saveSettings(settings),
    specs: [
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
      {
        key: "max-chars",
        type: "number",
        get: () => settings.naming.maxChars,
        set: (value) => {
          settings.naming.maxChars = value;
        },
      },
    ],
  });

  pi.registerCommand("rename", {
    description: "Rename the Orca tab title from the conversation or an explicit title",
    handler: (args: string, ctx: ExtensionCommandContext) => title.renameCommand(args, ctx),
  });

  pi.registerCommand("pi-orca", {
    description: "Configure the Orca completion mark and tab title naming",
    handler: settingsCommand,
  });

  pi.on("session_start", async (_event, ctx) => {
    if (!isMainAgentSession(ctx)) return;

    title.reset();
    settings = loadSettings();
    orca.refresh();
    await title.restoreExistingTitle(ctx);
  });

  pi.on("before_agent_start", async (event, ctx: ExtensionContext) => {
    if (!isMainAgentSession(ctx)) return;

    const firstPrompt = getFirstUserPrompt(ctx.sessionManager.getBranch()) ?? event.prompt;
    void title.applyAutoTitle(firstPrompt, ctx);
  });

  pi.on("agent_start", async (_event, ctx) => {
    if (!isMainAgentSession(ctx) || !terminalHandle) return;

    orca.refresh();
    const alert = createCompletionAlert(orca, {
      enabled: settings.completionAlert.enabled,
      bellEnabled: false,
      mark: settings.completionAlert.mark,
      ringBell: () => {},
    });
    await alert.prepareForAgentStart(terminalHandle);
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!isMainAgentSession(ctx) || !terminalHandle) return;

    orca.refresh();
    const alert = createCompletionAlert(orca, {
      enabled: settings.completionAlert.enabled,
      bellEnabled: false,
      focusedMarkAutoClearMs: settings.completionAlert.focusedMarkAutoClearMs,
      markWatchIntervalMs: settings.completionAlert.markWatchIntervalMs,
      markWatchMaxMs: settings.completionAlert.markWatchMaxMs,
      mark: settings.completionAlert.mark,
      ringBell: () => {},
    });
    await alert.notifyAgentEnd(terminalHandle);
  });
}
