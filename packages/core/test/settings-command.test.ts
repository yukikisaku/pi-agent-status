import assert from "node:assert/strict";
import test from "node:test";

import { initTheme, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

import {
  createSettingsCommand,
  formatSettingValue,
  parseSettingInput,
  type SettingSpec,
} from "../settings-command.ts";

initTheme("dark", false);

const fakeTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

const fakeKeybindings = {
  matches: (data: string, binding: string) =>
    (binding === "tui.select.confirm" && data === "\r") ||
    (binding === "tui.select.cancel" && data === "\x1b"),
};

function commandContext(
  interact: (component: Component) => void,
  notifications: Array<{ message: string; level: string }> = [],
): ExtensionCommandContext {
  return {
    mode: "tui",
    hasUI: true,
    ui: {
      custom: async (factory: Function) => {
        const component = factory(
          { requestRender() {} },
          fakeTheme,
          fakeKeybindings,
          () => undefined,
        ) as Component;
        interact(component);
        return undefined;
      },
      notify: (message: string, level: string) => notifications.push({ message, level }),
    },
  } as unknown as ExtensionCommandContext;
}

test("formats booleans as on/off and empty strings with their label", () => {
  const booleanSpec: SettingSpec = {
    key: "spinner",
    type: "boolean",
    get: () => true,
    set() {},
  };
  const stringSpec: SettingSpec = {
    key: "naming-model",
    type: "string",
    allowEmpty: true,
    emptyValueLabel: "(current session model)",
    get: () => "",
    set() {},
  };

  assert.equal(formatSettingValue(booleanSpec), "on");
  assert.equal(formatSettingValue(stringSpec), "(current session model)");
});

test("validates editable string and number values", () => {
  const requiredString: SettingSpec = {
    key: "mark",
    type: "string",
    get: () => "🔔",
    set() {},
  };
  const optionalString: SettingSpec = {
    key: "naming-model",
    type: "string",
    allowEmpty: true,
    get: () => "",
    set() {},
  };
  const numberSpec: SettingSpec = {
    key: "max-chars",
    type: "number",
    get: () => 50,
    set() {},
  };

  assert.deepEqual(parseSettingInput(requiredString, "  "), {
    ok: false,
    error: "Value cannot be empty",
  });
  assert.deepEqual(parseSettingInput(optionalString, "  "), { ok: true, value: "" });
  assert.deepEqual(parseSettingInput(numberSpec, "42"), { ok: true, value: 42 });
  assert.deepEqual(parseSettingInput(numberSpec, "nope"), {
    ok: false,
    error: "Enter a valid number",
  });
});

test("ignores command arguments and opens the menu", async () => {
  let enabled = true;
  let saves = 0;
  const command = createSettingsCommand({
    name: "pi-test",
    specs: [
      {
        key: "spinner",
        type: "boolean",
        get: () => enabled,
        set: (value) => {
          enabled = value;
        },
      },
    ],
    save: () => {
      saves++;
    },
  });

  await command("spinner off", commandContext((component) => component.handleInput?.("\r")));
  await Promise.resolve();

  assert.equal(enabled, false);
  assert.equal(saves, 1);
});

test("cancelling text editing leaves the setting unchanged", async () => {
  let mark = "🔔";
  let saves = 0;
  const command = createSettingsCommand({
    name: "pi-test",
    specs: [
      {
        key: "mark",
        type: "string",
        get: () => mark,
        set: (value) => {
          mark = value;
        },
      },
    ],
    save: () => {
      saves++;
    },
  });

  await command(
    "anything",
    commandContext((component) => {
      component.handleInput?.("\r");
      component.handleInput?.("x");
      component.handleInput?.("\x1b");
    }),
  );

  assert.equal(mark, "🔔");
  assert.equal(saves, 0);
});

test("invalid number input stays unsaved", async () => {
  let maxChars = 7;
  let saves = 0;
  const command = createSettingsCommand({
    name: "pi-test",
    specs: [
      {
        key: "max-chars",
        type: "number",
        get: () => maxChars,
        set: (value) => {
          maxChars = value;
        },
      },
    ],
    save: () => {
      saves++;
    },
  });

  await command(
    "ignored",
    commandContext((component) => {
      component.handleInput?.("\r");
      component.handleInput?.("\x7f");
      component.handleInput?.("x");
      component.handleInput?.("\r");
      component.handleInput?.("\x1b");
    }),
  );

  assert.equal(maxChars, 7);
  assert.equal(saves, 0);
});

test("rejects non-TUI mode", async () => {
  const notifications: Array<{ message: string; level: string }> = [];
  const command = createSettingsCommand({ name: "pi-test", specs: [], save() {} });
  const ctx = {
    mode: "rpc",
    hasUI: true,
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
    },
  } as unknown as ExtensionCommandContext;

  await command("ignored", ctx);

  assert.deepEqual(notifications, [
    { message: "/pi-test requires TUI mode", level: "error" },
  ]);
});
