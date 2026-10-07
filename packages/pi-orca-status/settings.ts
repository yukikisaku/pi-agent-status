import {
  asObject,
  DEFAULT_COMPLETION_ALERT,
  DEFAULT_NAMING,
  normalizeCompletionAlert,
  normalizeNaming,
  readSettingsFile,
  writeSettingsFile,
  type CompletionAlertConfig,
  type NamingConfig,
} from "./core/index.ts";

const SETTINGS_FILE = "pi-orca.json";

export type PiOrcaSettings = {
  completionAlert: CompletionAlertConfig;
  naming: NamingConfig;
};

export const DEFAULT_SETTINGS: PiOrcaSettings = {
  // Orca already plays its own completion sound, so only add the tab mark.
  completionAlert: {
    ...DEFAULT_COMPLETION_ALERT,
    bellEnabled: false,
    markWatchIntervalMs: 1000,
  },
  naming: { ...DEFAULT_NAMING },
};

export function normalizeSettings(value: unknown): PiOrcaSettings {
  const root = asObject(value);
  return {
    completionAlert: normalizeCompletionAlert(
      root.completionAlert,
      DEFAULT_SETTINGS.completionAlert,
    ),
    naming: normalizeNaming(root.naming),
  };
}

export function loadSettings(): PiOrcaSettings {
  return normalizeSettings(readSettingsFile(SETTINGS_FILE));
}

export function saveSettings(settings: PiOrcaSettings): void {
  writeSettingsFile(SETTINGS_FILE, settings);
}
