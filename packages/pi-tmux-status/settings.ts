import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  asObject,
  DEFAULT_COMPLETION_ALERT,
  DEFAULT_NAMING,
  DEFAULT_SPINNER,
  normalizeCompletionAlert,
  normalizeNaming,
  normalizeSpinner,
  readBoolean,
  readSettingsFile,
  readString,
  readStringArray,
  writeSettingsFile,
  type CompletionAlertConfig,
  type NamingConfig,
  type SpinnerConfig,
} from "./core/index.ts";

const SETTINGS_FILE = "pi-tmux.json";
const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_NOTIFICATION_SOUND = join(PACKAGE_DIR, "assets", "notification.mp3");

export type PiTmuxSettings = {
  spinner: SpinnerConfig;
  completionAlert: CompletionAlertConfig & { hookEnabled: boolean };
  sound: {
    enabled: boolean;
    command: string;
    args: string[];
  };
  naming: NamingConfig;
};

export const DEFAULT_SETTINGS: PiTmuxSettings = {
  spinner: { ...DEFAULT_SPINNER },
  completionAlert: { ...DEFAULT_COMPLETION_ALERT, hookEnabled: true },
  sound: {
    enabled: true,
    command: "mpv",
    args: ["--no-video", "--really-quiet", DEFAULT_NOTIFICATION_SOUND],
  },
  naming: { ...DEFAULT_NAMING },
};

export function normalizeSettings(value: unknown): PiTmuxSettings {
  const root = asObject(value);
  const alert = asObject(root.completionAlert);
  const sound = asObject(root.sound);

  return {
    spinner: normalizeSpinner(root.spinner),
    completionAlert: {
      ...normalizeCompletionAlert(root.completionAlert),
      hookEnabled: readBoolean(alert.hookEnabled, DEFAULT_SETTINGS.completionAlert.hookEnabled),
    },
    sound: {
      enabled: readBoolean(sound.enabled, DEFAULT_SETTINGS.sound.enabled),
      command: readString(sound.command, DEFAULT_SETTINGS.sound.command),
      args: readStringArray(sound.args, DEFAULT_SETTINGS.sound.args),
    },
    naming: normalizeNaming(root.naming),
  };
}

export function loadSettings(): PiTmuxSettings {
  return normalizeSettings(readSettingsFile(SETTINGS_FILE));
}

export function saveSettings(settings: PiTmuxSettings): void {
  writeSettingsFile(SETTINGS_FILE, settings);
}
