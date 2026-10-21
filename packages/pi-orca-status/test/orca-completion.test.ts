import assert from "node:assert/strict";
import test from "node:test";

import { createCompletionAlert } from "../core/completion-alert.ts";
import { createOrcaRuntime, type OrcaExec } from "../orca-runtime.ts";

type Terminal = {
  handle: string;
  worktreeId: string;
  tabId: string;
  title?: string | null;
};
type Pane = { type: "terminal"; handle: string; title?: string | null } | {
  type: "pane-split";
  first: Pane;
  second: Pane;
};
type Snapshot = {
  ok: boolean;
  result: {
    terminals: Terminal[];
    visualLayouts: Array<{
      worktreeId: string;
      root: {
        activeTabId: string;
        tabs: Array<{ tabId: string; title: string; panes?: Pane }>;
      };
    }>;
  };
};

function createHarness(prepare: (snapshot: Snapshot) => void = () => {}) {
  const snapshot: Snapshot = {
    ok: true,
    result: {
      terminals: [{ handle: "term-1", worktreeId: "worktree-1", tabId: "tab-1", title: "Fix OAuth callback" }],
      visualLayouts: [{
        worktreeId: "worktree-1",
        root: {
          activeTabId: "tab-1",
          tabs: [{
            tabId: "tab-1",
            title: "Terminal",
            panes: { type: "terminal", handle: "term-1", title: "Fix OAuth callback" },
          }],
        },
      }],
    },
  };
  prepare(snapshot);
  const writes: Array<{ handle: string; title: string }> = [];
  const clears: Array<() => Promise<void>> = [];
  const watchers: Array<() => Promise<boolean>> = [];
  let failReads = false;
  let failRenames = false;
  const exec: OrcaExec = async (_command, args) => {
    if (args[1] === "list") {
      return failReads ? { code: 1 } : { code: 0, stdout: JSON.stringify(snapshot) };
    }
    assert.equal(args[1], "rename");
    if (failRenames) return { code: 1 };
    const handle = args[args.indexOf("--terminal") + 1]!;
    const title = args[args.indexOf("--title") + 1]!;
    writes.push({ handle, title });
    const terminal = snapshot.result.terminals.find((candidate) => candidate.handle === handle);
    if (terminal) terminal.title = title;
    function renamePane(pane: Pane | undefined): void {
      if (pane?.type === "terminal" && pane.handle === handle) pane.title = title;
      if (pane?.type === "pane-split") {
        renamePane(pane.first);
        renamePane(pane.second);
      }
    }
    for (const layout of snapshot.result.visualLayouts) {
      for (const tab of layout.root.tabs) renamePane(tab.panes);
    }
    return { code: 0, stdout: JSON.stringify({ ok: true, result: {} }) };
  };
  const orca = createOrcaRuntime(exec, { ORCA_PANE_KEY: "tab-1:leaf-1" });
  const alert = createCompletionAlert(orca, {
    enabled: true,
    bellEnabled: false,
    mark: "🔔",
    focusedMarkAutoClearMs: 5000,
    ringBell: () => assert.fail("no extra bell"),
    scheduleAutoClear: (callback) => { clears.push(callback); },
    watchMarkedTarget: (callback) => { watchers.push(callback); },
  });
  return {
    snapshot, orca, alert, writes, clears, watchers,
    set failReads(value: boolean) { failReads = value; },
    set failRenames(value: boolean) { failRenames = value; },
  };
}

test("completion keeps the pane title when the outer tab remains Terminal", async () => {
  const h = createHarness();
  await h.alert.notifyAgentEnd("term-1");
  assert.deepEqual(h.writes, [{ handle: "term-1", title: "🔔 Fix OAuth callback" }]);
  assert.equal(h.snapshot.result.visualLayouts[0]!.root.tabs[0]!.title, "Terminal");
});

test("a focused mark is cleared after refreshing the snapshot without losing the task name", async () => {
  const h = createHarness();
  await h.alert.notifyAgentEnd("term-1");
  h.orca.refresh();
  await h.clears[0]!();
  assert.equal(h.writes.at(-1)?.title, "Fix OAuth callback");
});

test("repeated agent turns clear and restore the completion mark on the task name", async () => {
  const h = createHarness();
  for (let turn = 0; turn < 3; turn++) {
    h.orca.refresh();
    await h.alert.prepareForAgentStart("term-1");
    assert.equal(await h.orca.getName("term-1"), "Fix OAuth callback");
    h.orca.refresh();
    await h.alert.notifyAgentEnd("term-1");
    assert.equal(h.writes.at(-1)?.title, "🔔 Fix OAuth callback");
  }
});

test("background completion clears the mark when the task tab becomes visible", async () => {
  const h = createHarness((s) => { s.result.visualLayouts[0]!.root.activeTabId = "tab-2"; });
  await h.alert.notifyAgentEnd("term-1");
  assert.equal(await h.watchers[0]!(), false);
  h.snapshot.result.visualLayouts[0]!.root.activeTabId = "tab-1";
  h.orca.refresh();
  assert.equal(await h.watchers[0]!(), true);
  assert.equal(h.writes.at(-1)?.title, "Fix OAuth callback");
});

test("renaming a split pane leaves the sibling's cached and refreshed title unchanged", async () => {
  const h = createHarness((s) => {
    s.result.terminals.push({ handle: "term-2", worktreeId: "worktree-1", tabId: "tab-1", title: "Other task" });
    const tab = s.result.visualLayouts[0]!.root.tabs[0]!;
    tab.panes = { type: "pane-split", first: tab.panes!, second: { type: "terminal", handle: "term-2", title: "Other task" } };
  });
  await h.alert.notifyAgentEnd("term-1");
  assert.equal(await h.orca.getName("term-1"), "🔔 Fix OAuth callback");
  assert.equal(await h.orca.getName("term-2"), "Other task");
  h.orca.refresh();
  assert.equal(await h.orca.getName("term-1"), "🔔 Fix OAuth callback");
  assert.equal(await h.orca.getName("term-2"), "Other task");
});

test("missing summary title uses the exact split pane rather than its sibling", async () => {
  const h = createHarness((s) => {
    delete s.result.terminals[0]!.title;
    const tab = s.result.visualLayouts[0]!.root.tabs[0]!;
    tab.panes = { type: "pane-split", first: { type: "terminal", handle: "term-2", title: "Other task" }, second: tab.panes! };
  });
  await h.alert.notifyAgentEnd("term-1");
  assert.equal(h.writes.at(-1)?.title, "🔔 Fix OAuth callback");
});

test("pane fallback does not read a matching tab from a different worktree", async () => {
  const h = createHarness((s) => {
    delete s.result.terminals[0]!.title;
    const other = structuredClone(s.result.visualLayouts[0]!);
    other.worktreeId = "worktree-2";
    other.root.tabs[0]!.panes = { type: "terminal", handle: "term-1", title: "Other worktree" };
    s.result.visualLayouts.unshift(other);
  });
  await h.alert.notifyAgentEnd("term-1");
  assert.equal(h.writes.at(-1)?.title, "🔔 Fix OAuth callback");
});

test("summary titles still work when the host omits visual layouts", async () => {
  const h = createHarness((s) => { s.result.visualLayouts = []; });
  await h.alert.notifyAgentEnd("term-1");
  assert.equal(h.writes.at(-1)?.title, "🔔 Fix OAuth callback");
});

test("manual renames remain intact across cache refresh and completion", async () => {
  const h = createHarness();
  await h.orca.getName("term-1");
  await h.orca.setName("term-1", "Manual title");
  assert.equal(await h.orca.getName("term-1"), "Manual title");
  h.orca.refresh();
  await h.alert.notifyAgentEnd("term-1");
  assert.equal(h.writes.at(-1)?.title, "🔔 Manual title");
});

test("missing modern titles never fall back to the default outer Terminal", async () => {
  const h = createHarness((s) => {
    s.result.terminals[0]!.title = null;
    const pane = s.result.visualLayouts[0]!.root.tabs[0]!.panes!;
    if (pane.type === "terminal") pane.title = null;
  });
  await h.alert.notifyAgentEnd("term-1");
  assert.deepEqual(h.writes, []);
});

test("unavailable terminal metadata does not replace a title with a bare mark", async () => {
  const h = createHarness();
  h.failReads = true;
  await h.alert.notifyAgentEnd("term-1");
  assert.deepEqual(h.writes, []);
});

test("failed completion writes do not create cached titles or clear tasks", async () => {
  const h = createHarness();
  h.failRenames = true;
  await h.alert.notifyAgentEnd("term-1");
  assert.equal(await h.orca.getName("term-1"), "Fix OAuth callback");
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.clears, []);
  assert.deepEqual(h.watchers, []);
});
