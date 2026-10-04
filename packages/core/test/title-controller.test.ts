import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { createTitleController, type TitleControllerOptions } from "../title-controller.ts";

const NAMING = { enabled: true, model: "", thinking: "low", maxChars: 32 };

function contextStub(): ExtensionCommandContext {
  return { hasUI: true, ui: { notify() {} } } as unknown as ExtensionCommandContext;
}

type SessionHarness = {
  pi: TitleControllerOptions["pi"];
  sessionWrites: string[];
  tabWrites: string[];
  sessionName: { value: string | undefined };
};

function sessionHarness(sessionName: string | undefined = undefined): SessionHarness {
  const sessionWrites: string[] = [];
  const tabWrites: string[] = [];
  const name = { value: sessionName };

  const pi = {
    getSessionName: () => name.value,
    setSessionName: (next: string) => {
      sessionWrites.push(next);
      name.value = next;
    },
  } as unknown as TitleControllerOptions["pi"];

  return { pi, sessionWrites, tabWrites, sessionName: name };
}

test("applyExternalTitle mirrors an external rename via pushTabTitle", async () => {
  const { pi, sessionWrites, tabWrites } = sessionHarness("Old label");

  const title = createTitleController({
    pi,
    getNaming: () => NAMING,
    applyTitle(rawTitle) {
      sessionWrites.push(rawTitle);
      return rawTitle;
    },
    pushTabTitle(normalizedTitle) {
      tabWrites.push(normalizedTitle);
      return normalizedTitle;
    },
  });

  assert.equal(await title.applyExternalTitle("Fix OAuth callback", contextStub()), true);
  assert.deepEqual(tabWrites, ["Fix OAuth callback"]);
  // The host already persisted the name; the callback must not rewrite it.
  assert.deepEqual(sessionWrites, []);

  // An unchanged name must not push again.
  assert.equal(await title.applyExternalTitle("Fix OAuth callback", contextStub()), false);
  assert.deepEqual(tabWrites, ["Fix OAuth callback"]);
});

test("applyExternalTitle compacts long names and scales with maxChars", async () => {
  const { pi, tabWrites } = sessionHarness();

  const title = createTitleController({
    pi,
    getNaming: () => ({ ...NAMING, maxChars: 10 }),
    applyTitle(rawTitle) {
      return rawTitle;
    },
    pushTabTitle(normalizedTitle) {
      tabWrites.push(normalizedTitle);
      return normalizedTitle;
    },
  });

  assert.equal(await title.applyExternalTitle("A rather long session title", contextStub()), true);
  assert.deepEqual(tabWrites, ["A rather l"]);
});

test("applyExternalTitle still mirrors explicit renames while naming is off", async () => {
  const { pi, tabWrites } = sessionHarness();

  const title = createTitleController({
    pi,
    getNaming: () => ({ ...NAMING, enabled: false }),
    applyTitle(rawTitle) {
      return rawTitle;
    },
    pushTabTitle(normalizedTitle) {
      tabWrites.push(normalizedTitle);
      return normalizedTitle;
    },
  });

  assert.equal(await title.applyExternalTitle("Manual rename", contextStub()), true);
  assert.deepEqual(tabWrites, ["Manual rename"]);
});

test("restoreExistingTitle pushes the resumed name once without rewriting the session", async () => {
  const { pi, sessionWrites, tabWrites, sessionName } = sessionHarness("Resumed label");

  const title = createTitleController({
    pi,
    getNaming: () => NAMING,
    applyTitle(rawTitle) {
      sessionWrites.push(rawTitle);
      return rawTitle;
    },
    pushTabTitle(normalizedTitle) {
      tabWrites.push(normalizedTitle);
      return normalizedTitle;
    },
  });

  assert.equal(await title.restoreExistingTitle(contextStub()), true);
  assert.deepEqual(tabWrites, ["Resumed label"]);
  assert.deepEqual(sessionWrites, []);

  sessionName.value = undefined;
  assert.equal(await title.restoreExistingTitle(contextStub()), false);
  assert.deepEqual(tabWrites, ["Resumed label"]);
});

test("the rename event from our own setSessionName does not double-apply", async () => {
  const { pi, sessionName } = sessionHarness();
  let releaseApply: () => void = () => {};
  const applyGate = new Promise<void>((resolve) => { releaseApply = resolve; });
  let applyCalls = 0;

  const title = createTitleController({
    pi,
    getNaming: () => NAMING,
    async applyTitle(rawTitle) {
      applyCalls += 1;
      // Hold inside applyTitle: pi.setSessionName has already fired, and the
      // session_info_changed dispatch reaches us while this promise hangs.
      sessionName.value = rawTitle;
      await applyGate;
      return rawTitle;
    },
  });

  const commandCtx = {
    hasUI: true,
    ui: { notify() {} },
    waitForIdle: async () => {},
  } as unknown as ExtensionCommandContext;
  const rename = title.renameCommand("Explicit name", commandCtx);

  // Let renameCommand reach the synchronous part of persistTitle.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(applyCalls, 1);
  assert.equal(sessionName.value, "Explicit name");

  // The event that our own setSessionName fired arrives while the push is still
  // in flight: dedupe against the in-flight title instead of re-applying.
  assert.equal(await title.applyExternalTitle("Explicit name", contextStub()), false);
  assert.equal(applyCalls, 1);

  releaseApply();
  await rename;
  assert.equal(applyCalls, 1);

  // Once applied, the same name stays deduped by the recorded title.
  assert.equal(await title.applyExternalTitle("Explicit name", contextStub()), false);
  assert.equal(applyCalls, 1);
});

const waitFor = async (check: () => boolean, ticks = 200): Promise<void> => {
  for (let i = 0; i < ticks; i++) {
    if (check()) return;
    await sleep(10);
  }
  assert.ok(check(), "condition was not met in time");
};

test("session-name watcher applies external renames and retries failed pushes", async () => {
  const { pi, tabWrites, sessionName, sessionWrites } = sessionHarness();

  let shouldFailNextPush = true;
  let pushes = 0;

  const title = createTitleController({
    pi,
    // naming stays off to prove external renames still reach the tab
    getNaming: () => ({ ...NAMING, enabled: false }),
    applyTitle(rawTitle) {
      sessionWrites.push(rawTitle);
      return rawTitle;
    },
    async pushTabTitle(normalizedTitle) {
      pushes += 1;
      if (shouldFailNextPush) {
        shouldFailNextPush = false;
        return undefined;
      }
      tabWrites.push(normalizedTitle);
      return normalizedTitle;
    },
    externalNamePollMs: 10,
  });

  title.startSessionNameWatch(contextStub());
  sessionName.value = "Renamed by the host";

  await waitFor(() => pushes >= 2 && tabWrites.length === 1);
  assert.deepEqual(tabWrites, ["Renamed by the host"]);
  // The failed push did not claim the title, the retry did, and later ticks
  // dedupe against the recorded name instead of pushing forever.
  await sleep(40);
  assert.deepEqual(tabWrites, ["Renamed by the host"]);
  assert.equal(pushes, 2);

  title.stopSessionNameWatch();
  const pushesAtStop = pushes;
  sessionName.value = "Renamed after stop";
  await sleep(40);
  assert.equal(pushes, pushesAtStop);
});
