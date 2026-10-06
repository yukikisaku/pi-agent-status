import {
  asObject,
  DEFAULT_COMPLETION_ALERT,
  DEFAULT_NAMING,
  DEFAULT_SPINNER,
  normalizeCompletionAlert,
  normalizeNaming,
  normalizeSpinner,
  readSettingsFile,
  writeSettingsFile,
  type CompletionAlertConfig,
  type NamingConfig,
  type SpinnerConfig,
} from "./core/index.ts";

const SETTINGS_FILE = "pi-herdr.json";

export type PiHerdrSettings = {
  spinner: SpinnerConfig;
  completionAlert: CompletionAlertConfig;
  naming: NamingConfig;
};

export const DEFAULT_SETTINGS: PiHerdrSettings = {
  spinner: { ...DEFAULT_SPINNER },
  // Herdr plays its own completion sound, so no terminal bell here.
  completionAlert: { ...DEFAULT_COMPLETION_ALERT, bellEnabled: false },
  naming: { ...DEFAULT_NAMING },
};

export function normalizeSettings(value: unknown): PiHerdrSettings {
  const root = asObject(value);

  return {
    spinner: normalizeSpinner(root.spinner),
    completionAlert: normalizeCompletionAlert(root.completionAlert, DEFAULT_SETTINGS.completionAlert),
    naming: normalizeNaming(root.naming),
  };
}

export function loadSettings(): PiHerdrSettings {
  return normalizeSettings(readSettingsFile(SETTINGS_FILE));
}

export function saveSettings(settings: PiHerdrSettings): void {
  writeSettingsFile(SETTINGS_FILE, settings);
}
