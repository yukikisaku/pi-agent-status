import assert from "node:assert/strict";
import test from "node:test";

import { createOrcaRuntime, type OrcaExec } from "../orca-runtime.ts";

function terminalListResponse(
  activeTabId = "tab-1",
  tabTitle = "Fix OAuth callback",
  paneTitle = tabTitle,
): string {
  return JSON.stringify({
    ok: true,
    result: {
      terminals: [
        {
          handle: "term-1",
          worktreeId: "worktree-1",
          tabId: "tab-1",
          title: paneTitle,
        },
      ],
      visualLayouts: [
        {
          worktreeId: "worktree-1",
          root: {
            type: "group",
            activeTabId,
            tabs: [
              { tabId: "tab-1", title: tabTitle },
              { tabId: "tab-2", title: "Other task" },
            ],
          },
        },
      ],
    },
  });
}

test("the current Orca tab title and visibility come from one cached terminal list", async () => {
  const calls: string[][] = [];
  const exec: OrcaExec = async (_command, args) => {
    calls.push(args);
    return { code: 0, stdout: terminalListResponse() };
  };
  const orca = createOrcaRuntime(exec, {
    ORCA_PANE_KEY: "pane-1",
    ORCA_TERMINAL_HANDLE: "term-1",
    ORCA_CLI_PATH: "custom-orca",
  });

  assert.equal(await orca.getName("term-1"), "Fix OAuth callback");
  assert.equal(await orca.isTargetVisible("term-1"), true);
  assert.deepEqual(calls, [["terminal", "list", "--limit", "1000", "--json"]]);
});

test("Orca's working spinner in the pane title is excluded from the tab name", async () => {
  const calls: string[][] = [];
  const exec: OrcaExec = async (_command, args) => {
    calls.push(args);
    return {
      code: 0,
      stdout: terminalListResponse("tab-1", "Fix OAuth callback", "⠼ Pi"),
    };
  };
  const orca = createOrcaRuntime(exec, { ORCA_PANE_KEY: "pane-1" });

  assert.equal(await orca.getName("term-1"), "Fix OAuth callback");
  assert.equal(await orca.setName("term-1", "🔔 Fix OAuth callback"), true);
  assert.equal(await orca.getName("term-1"), "🔔 Fix OAuth callback");
  assert.equal(calls.length, 2);
});

test("newer Orca versions are retried with the visual layouts flag", async () => {
  const calls: string[][] = [];
  const withoutLayouts = JSON.parse(terminalListResponse()) as {
    result: { visualLayouts?: unknown };
  };
  delete withoutLayouts.result.visualLayouts;

  const exec: OrcaExec = async (_command, args) => {
    calls.push(args);
    return {
      code: 0,
      stdout: args.includes("--include-visual-layouts")
        ? terminalListResponse()
        : JSON.stringify(withoutLayouts),
    };
  };
  const orca = createOrcaRuntime(exec, { ORCA_PANE_KEY: "pane-1" });

  assert.equal(await orca.isTargetVisible("term-1"), true);
  orca.refresh();
  assert.equal(await orca.isTargetVisible("term-1"), true);
  assert.deepEqual(calls, [
    ["terminal", "list", "--limit", "1000", "--json"],
    ["terminal", "list", "--limit", "1000", "--include-visual-layouts", "--json"],
    ["terminal", "list", "--limit", "1000", "--include-visual-layouts", "--json"],
  ]);
});

test("a terminal is hidden when another tab is active", async () => {
  const exec: OrcaExec = async () => ({
    code: 0,
    stdout: terminalListResponse("tab-2"),
  });
  const orca = createOrcaRuntime(exec, { ORCA_PANE_KEY: "pane-1" });

  assert.equal(await orca.isTargetVisible("term-1"), false);
});

test("renaming targets the runtime-issued terminal handle", async () => {
  const calls: Array<{ command: string; args: string[]; timeout: number }> = [];
  const exec: OrcaExec = async (command, args, options) => {
    calls.push({ command, args, timeout: options.timeout });
    return { code: 0, stdout: JSON.stringify({ ok: true, result: {} }) };
  };
  const orca = createOrcaRuntime(exec, {
    ORCA_PANE_KEY: "pane-1",
    ORCA_CLI_PATH: "custom-orca",
  });

  assert.equal(await orca.setName("term-1", "🔔 Fix OAuth callback"), true);
  assert.deepEqual(calls, [
    {
      command: "custom-orca",
      args: [
        "terminal",
        "rename",
        "--terminal",
        "term-1",
        "--title",
        "🔔 Fix OAuth callback",
        "--json",
      ],
      timeout: 5000,
    },
  ]);
});

test("invalid or unavailable terminal metadata fails safely", async () => {
  const exec: OrcaExec = async () => ({ code: 0, stdout: "not json" });
  const orca = createOrcaRuntime(exec, { ORCA_PANE_KEY: "pane-1" });

  assert.equal(await orca.getName("term-1"), "");
  assert.equal(await orca.isTargetVisible("term-1"), false);
});

test("the extension activates only in Orca and normalizes its terminal handle", () => {
  const exec: OrcaExec = async () => ({ code: 0 });

  assert.equal(createOrcaRuntime(exec, {}).isAvailable(), false);

  const orca = createOrcaRuntime(exec, {
    ORCA_PANE_KEY: "pane-1",
    ORCA_TERMINAL_HANDLE: "  term-1  ",
  });
  assert.equal(orca.isAvailable(), true);
  assert.equal(orca.terminalHandle(), "term-1");
});
