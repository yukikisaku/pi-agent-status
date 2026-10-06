import {
  asObject,
  DEFAULT_NAMING,
  DEFAULT_SPINNER,
  normalizeNaming,
  normalizeSpinner,
  readBoolean,
  readSettingsFile,
  writeSettingsFile,
  type NamingConfig,
  type SpinnerConfig,
} from "./core/index.ts";

const SETTINGS_FILE = "pi-zed-plugin.json";

export type PiZedSettings = {
  spinner: SpinnerConfig;
  bell: { enabled: boolean };
  naming: NamingConfig;
};

export const DEFAULT_SETTINGS: PiZedSettings = {
  spinner: { ...DEFAULT_SPINNER },
  bell: { enabled: true },
  naming: { ...DEFAULT_NAMING },
};

export function normalizeSettings(value: unknown): PiZedSettings {
  const root = asObject(value);
  const bell = asObject(root.bell);

  return {
    spinner: normalizeSpinner(root.spinner),
    bell: { enabled: readBoolean(bell.enabled, DEFAULT_SETTINGS.bell.enabled) },
    naming: normalizeNaming(root.naming),
  };
}

export function loadSettings(): PiZedSettings {
  return normalizeSettings(readSettingsFile(SETTINGS_FILE));
}

export function saveSettings(settings: PiZedSettings): void {
  writeSettingsFile(SETTINGS_FILE, settings);
}
