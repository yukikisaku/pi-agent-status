import assert from "node:assert/strict";
import test from "node:test";

import { createTmuxRuntime, type TmuxExec } from "../tmux-runtime.ts";

test("the tmux client counts as focused when client flags include focused", async () => {
  const exec: TmuxExec = async (_command, args) => {
    if (args.at(-1) === "#{client_flags}") {
      return { code: 0, stdout: "attached,focused,UTF-8" };
    }
    return { code: 1 };
  };

  const tmux = createTmuxRuntime(exec, { TMUX: "tmux", TMUX_PANE: "%1" });

  assert.equal(await tmux.isAppFocused(), true);
});

test("the tmux client counts as unfocused when client flags omit focused", async () => {
  const exec: TmuxExec = async (_command, args) => {
    if (args.at(-1) === "#{client_flags}") {
      return { code: 0, stdout: "attached,UTF-8" };
    }
    return { code: 1 };
  };

  const tmux = createTmuxRuntime(exec, { TMUX: "tmux", TMUX_PANE: "%1" });

  assert.equal(await tmux.isAppFocused(), false);
});

test("clear alert hooks fire on window select and on delayed client focus", async () => {
  const setHookArgs: string[][] = [];
  const unsetHookArgs: string[][] = [];
  const exec: TmuxExec = async (_command, args) => {
    if (args[0] === "set-hook" && args[1] === "-g") setHookArgs.push(args);
    if (args[0] === "set-hook" && args[1] === "-gu") unsetHookArgs.push(args);
    return { code: 0 };
  };

  const tmux = createTmuxRuntime(exec, { TMUX: "tmux", TMUX_PANE: "%1" });

  await tmux.installClearAlertHooks("🔔", 5000);

  assert.deepEqual(
    setHookArgs.map((args) => args[2]),
    ["after-select-window[900]", "after-select-window[901]", "client-focus-in[900]", "client-active[900]"],
  );
  assert.match(setHookArgs[0]?.[3] ?? "", /#\{window_id\}/);
  assert.match(setHookArgs[0]?.[3] ?? "", /#\{window_name\}/);
  assert.match(setHookArgs[1]?.[3] ?? "", /sleep 0\.25/);
  assert.match(setHookArgs[2]?.[3] ?? "", /sleep 5/);
  assert.deepEqual(
    unsetHookArgs.map((args) => args[2]),
    ["client-session-changed[900]"],
  );
});

test("the working flag is stored as a tmux window option", async () => {
  const calls: string[][] = [];
  const exec: TmuxExec = async (_command, args) => {
    calls.push(args);
    return { code: 0 };
  };

  const tmux = createTmuxRuntime(exec, { TMUX: "tmux", TMUX_PANE: "%1" });

  assert.equal(await tmux.setWindowWorking("@2", true), true);
  assert.equal(await tmux.setWindowWorking("@2", false), true);
  assert.deepEqual(calls, [
    ["set-window-option", "-t", "@2", "@pi-tmux-working", "1"],
    ["set-window-option", "-t", "@2", "@pi-tmux-working", "0"],
  ]);
});

test("a session is busy when any of its windows carries the working flag", async () => {
  let listArgs: string[] | undefined;
  const exec: TmuxExec = async (_command, args) => {
    if (args[0] === "list-windows") {
      listArgs = args;
      return { code: 0, stdout: "@1\t0\n@2\t1\n@3\t" };
    }
    return { code: 1 };
  };

  const tmux = createTmuxRuntime(exec, { TMUX: "tmux", TMUX_PANE: "%1" });

  assert.equal(await tmux.hasWorkingWindowInSession("$1"), true);
  assert.deepEqual(listArgs, ["list-windows", "-t", "$1", "-F", "#{window_id}\t#{@pi-tmux-working}"]);
});

test("the current session is resolved when no target is given", async () => {
  const calls: string[][] = [];
  const exec: TmuxExec = async (_command, args) => {
    calls.push(args);
    if (args.at(-1) === "#{session_id}") return { code: 0, stdout: "$7\n" };
    if (args[0] === "list-windows") return { code: 0, stdout: "@1\t0\n@2\t\n" };
    return { code: 1 };
  };

  const tmux = createTmuxRuntime(exec, { TMUX: "tmux", TMUX_PANE: "%1" });

  assert.equal(await tmux.hasWorkingWindowInSession(), false);
  assert.deepEqual(calls, [
    ["display-message", "-p", "-t", "%1", "#{session_id}"],
    ["list-windows", "-t", "$7", "-F", "#{window_id}\t#{@pi-tmux-working}"],
  ]);
});

test("tmux is unavailable when the environment has no tmux pane", async () => {
  const tmux = createTmuxRuntime(async () => ({ code: 0 }), {});
  assert.equal(tmux.isAvailable(), false);
});
