import {
  DynamicBorder,
  getSettingsListTheme,
  keyHint,
  type ExtensionCommandContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  type Focusable,
  Input,
  type KeybindingsManager,
  Spacer,
  type SettingItem,
  SettingsList,
  Text,
} from "@earendil-works/pi-tui";

import { notify } from "./title-controller.ts";

export type SettingSpec =
  | {
      key: string;
      type: "boolean";
      get(): boolean;
      set(value: boolean): void;
    }
  | {
      key: string;
      type: "enum";
      values: string[];
      describe?(value: string): string;
      get(): string;
      set(value: string): void;
    }
  | {
      key: string;
      type: "string";
      allowEmpty?: boolean;
      emptyValueLabel?: string;
      get(): string;
      set(value: string): void;
    }
  | {
      key: string;
      type: "number";
      get(): number;
      set(value: number): void;
    };

export type SettingsCommandOptions = {
  name: string;
  specs: SettingSpec[];
  onChange?: (key: string, ctx: ExtensionCommandContext) => Promise<void> | void;
  save: () => void;
};

type ParsedInput = { ok: true; value: string | number } | { ok: false; error: string };

export function formatSettingValue(spec: SettingSpec): string {
  const value = spec.get();
  if (spec.type === "boolean") return value ? "on" : "off";
  if (spec.type === "string" && !value && spec.emptyValueLabel) return spec.emptyValueLabel;
  return String(value);
}

export function parseSettingInput(spec: SettingSpec, rawValue: string): ParsedInput {
  const value = rawValue.trim();

  if (spec.type === "number") {
    if (!value) return { ok: false, error: "Enter a number" };
    const parsed = Number(value);
    return Number.isFinite(parsed)
      ? { ok: true, value: parsed }
      : { ok: false, error: "Enter a valid number" };
  }

  if (spec.type === "string") {
    if (!value && !spec.allowEmpty) return { ok: false, error: "Value cannot be empty" };
    return { ok: true, value };
  }

  return { ok: false, error: "This setting is not editable as text" };
}

class ValueInputSubmenu extends Container implements Focusable {
  private readonly spec: Extract<SettingSpec, { type: "string" | "number" }>;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly onDone: (value?: string) => void;
  private readonly input: Input;
  private readonly titleText: Text;
  private readonly errorText: Text;
  private readonly hintText: Text;
  private error = "";
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  constructor(
    spec: Extract<SettingSpec, { type: "string" | "number" }>,
    theme: Theme,
    keybindings: KeybindingsManager,
    onDone: (value?: string) => void,
  ) {
    super();

    this.spec = spec;
    this.theme = theme;
    this.keybindings = keybindings;
    this.onDone = onDone;
    this.titleText = new Text("", 1, 0);
    this.errorText = new Text("", 1, 0);
    this.hintText = new Text("", 1, 0);
    this.input = new Input();
    this.input.setValue(String(spec.get()));

    this.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    this.addChild(new Spacer(1));
    this.addChild(this.titleText);
    this.addChild(new Spacer(1));
    this.addChild(this.input);
    this.addChild(this.errorText);
    this.addChild(new Spacer(1));
    this.addChild(this.hintText);
    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    this.updateText();
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.confirm") || data === "\n") {
      const parsed = parseSettingInput(this.spec, this.input.getValue());
      if (!parsed.ok) {
        this.error = parsed.error;
        this.updateText();
        return;
      }
      this.onDone(String(parsed.value));
      return;
    }

    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.onDone();
      return;
    }

    this.error = "";
    this.input.handleInput(data);
    this.updateText();
  }

  override invalidate(): void {
    super.invalidate();
    this.updateText();
  }

  private updateText(): void {
    this.titleText.setText(this.theme.fg("accent", this.theme.bold(`Edit ${this.spec.key}`)));
    this.errorText.setText(this.error ? this.theme.fg("error", this.error) : "");

    const emptyHint =
      this.spec.type === "string" && this.spec.allowEmpty && this.spec.emptyValueLabel
        ? ` · empty = ${this.spec.emptyValueLabel}`
        : "";
    this.hintText.setText(
      this.theme.fg(
        "dim",
        `${keyHint("tui.select.confirm", "save")} · ${keyHint("tui.select.cancel", "cancel")}${emptyHint}`,
      ),
    );
  }
}

function applySettingValue(spec: SettingSpec, value: string): void {
  if (spec.type === "boolean") {
    spec.set(value === "on");
  } else if (spec.type === "enum") {
    spec.set(value);
  } else {
    const parsed = parseSettingInput(spec, value);
    if (!parsed.ok) return;
    if (spec.type === "number") spec.set(parsed.value as number);
    else spec.set(parsed.value as string);
  }
}

export function createSettingsCommand(options: SettingsCommandOptions) {
  const specs = new Map(options.specs.map((spec) => [spec.key, spec]));

  return async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
    if (ctx.mode !== "tui") {
      notify(ctx, `/${options.name} requires TUI mode`, "error");
      return;
    }

    await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
      let activeInput: ValueInputSubmenu | undefined;
      let focused = false;
      let settingsList: SettingsList;

      const items: SettingItem[] = options.specs.map((spec) => {
        const item: SettingItem = {
          id: spec.key,
          label: spec.key,
          currentValue: formatSettingValue(spec),
        };

        if (spec.type === "boolean") {
          item.values = ["on", "off"];
        } else if (spec.type === "enum") {
          item.values = spec.values;
          item.description = spec.describe?.(spec.get());
        } else {
          item.submenu = (_currentValue, close) => {
            activeInput = new ValueInputSubmenu(spec, theme, keybindings, (value) => {
              activeInput = undefined;
              close(value);
            });
            activeInput.focused = focused;
            return activeInput;
          };
        }

        return item;
      });

      settingsList = new SettingsList(
        items,
        Math.min(items.length, 10),
        getSettingsListTheme(),
        (key, value) => {
          const spec = specs.get(key);
          if (!spec) return;

          applySettingValue(spec, value);
          settingsList.updateValue(key, formatSettingValue(spec));
          const item = items.find((candidate) => candidate.id === key);
          if (item && spec.type === "enum") item.description = spec.describe?.(spec.get());

          options.save();
          void Promise.resolve(options.onChange?.(key, ctx)).catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            notify(ctx, `Failed to apply ${key}: ${message}`, "error");
          });
        },
        () => done(undefined),
      );

      const container = new Container();
      container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
      container.addChild(settingsList);
      container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

      return {
        get focused() {
          return focused;
        },
        set focused(value: boolean) {
          focused = value;
          if (activeInput) activeInput.focused = value;
        },
        render: (width: number) => container.render(width),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          settingsList.handleInput(data);
          tui.requestRender();
        },
      } satisfies Component & Focusable;
    });
  };
}
