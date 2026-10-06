import assert from "node:assert/strict";
import test from "node:test";

import { createTmuxSessionActivityMonitor } from "../session-activity.ts";

function createTitleRuntime(initialTitle: string) {
  let title = initialTitle;
  const updates: string[] = [];

  return {
    runtime: {
      getTitle() {
        return title;
      },
      setTitle(nextTitle: string) {
        title = nextTitle;
        updates.push(nextTitle);
        return true;
      },
    },
    get title() {
      return title;
    },
    updates,
  };
}

test("the terminal title spins while a window of the session is busy", async () => {
  let working = true;
  const title = createTitleRuntime("OAuth認証の修正");
  const monitor = createTmuxSessionActivityMonitor(
    { hasWorkingWindowInSession: async () => working },
    title.runtime,
    { enabled: true, style: "classic", speed: "normal" },
  );

  await monitor.start();
  assert.equal(title.title, "- OAuth認証の修正");

  working = false;
  await monitor.sync();
  assert.equal(title.title, "OAuth認証の修正");
  assert.deepEqual(title.updates, ["- OAuth認証の修正", "OAuth認証の修正"]);

  await monitor.stop();
});

test("a disabled spinner stays idle even while a window is busy", async () => {
  const title = createTitleRuntime("OAuth認証の修正");
  const monitor = createTmuxSessionActivityMonitor(
    { hasWorkingWindowInSession: async () => true },
    title.runtime,
    { enabled: false, style: "classic", speed: "normal" },
  );

  await monitor.start();
  await monitor.sync();

  assert.equal(title.title, "OAuth認証の修正");
  assert.deepEqual(title.updates, []);
});
