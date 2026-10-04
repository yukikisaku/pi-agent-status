import assert from "node:assert/strict";
import test from "node:test";

import {
  createNamedTargetSpinner,
  createSimpleSpinner,
  SPINNER_SPEEDS,
  stripSpinnerFrames,
  type NamedTargetRuntime,
  type SimpleTitleRuntime,
} from "../spinner.ts";

test("named target spinner stop restores the name by removing only its last frame", async () => {
  let name = "Fix oauth callback";

  const runtime: NamedTargetRuntime = {
    async getName() {
      return name;
    },
    async setName(_targetId, next) {
      name = next;
      return true;
    },
  };

  const spinner = createNamedTargetSpinner(runtime, { enabled: true, style: "classic", speed: "normal" });

  await spinner.start("@1");
  assert.equal(name, "- Fix oauth callback");

  await spinner.stop();
  assert.equal(name, "Fix oauth callback");
});

test("named target spinner stop waits for an in-flight tick before restoring the name", async () => {
  const originalFastSpeed = SPINNER_SPEEDS.fast;
  SPINNER_SPEEDS.fast = 1;

  try {
    let name = "Fix oauth callback";
    let renameCount = 0;
    let releaseSecondRename = () => {};
    let secondRenameStarted = () => {};
    const secondRenameStartedPromise = new Promise<void>((resolve) => {
      secondRenameStarted = resolve;
    });

    const runtime: NamedTargetRuntime = {
      async getName() {
        return name;
      },
      async setName(_targetId, next) {
        renameCount += 1;
        if (renameCount === 2) {
          secondRenameStarted();
          await new Promise<void>((resolve) => {
            releaseSecondRename = resolve;
          });
        }

        name = next;
        return true;
      },
    };

    const spinner = createNamedTargetSpinner(runtime, { enabled: true, style: "classic", speed: "fast" });

    await spinner.start("@1");
    assert.equal(name, "- Fix oauth callback");

    await secondRenameStartedPromise;
    const stopPromise = spinner.stop();
    await new Promise<void>((resolve) => setImmediate(resolve));

    releaseSecondRename();
    await stopPromise;
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(name, "Fix oauth callback");
  } finally {
    SPINNER_SPEEDS.fast = originalFastSpeed;
  }
});

test("simple spinner stop restores the remembered title", async () => {
  let title = "OAuth認証の修正";
  const updates: string[] = [];

  const runtime: SimpleTitleRuntime = {
    getTitle() {
      return title;
    },
    setTitle(nextTitle) {
      title = nextTitle;
      updates.push(nextTitle);
      return true;
    },
  };

  const spinner = createSimpleSpinner(runtime, { enabled: true, style: "classic", speed: "normal" });

  await spinner.start();
  assert.equal(title, "- OAuth認証の修正");

  await spinner.stop();
  assert.equal(title, "OAuth認証の修正");
  assert.deepEqual(updates, ["- OAuth認証の修正", "OAuth認証の修正"]);
});

test("disabled spinner never touches the title", async () => {
  const updates: string[] = [];
  const runtime: SimpleTitleRuntime = {
    getTitle: () => "OAuth認証の修正",
    setTitle: (title) => {
      updates.push(title);
      return true;
    },
  };

  const spinner = createSimpleSpinner(runtime, { enabled: false, style: "classic", speed: "normal" });
  await spinner.start();
  await spinner.stop();

  assert.deepEqual(updates, []);
});

test("named target spinner stop removes a stale frame even when the remembered frame does not match", async () => {
  let name = "Fix oauth callback";

  const runtime: NamedTargetRuntime = {
    async getName() {
      return name;
    },
    async setName(_targetId, next) {
      name = next;
      return true;
    },
  };

  const spinner = createNamedTargetSpinner(runtime, { enabled: true, style: "braille", speed: "normal" });
  await spinner.start("@1");
  assert.equal(name, "⠋ Fix oauth callback");

  // The daemon label drifted from the remembered frame (e.g. a lost rename).
  name = "⠧ Fix oauth callback";

  await spinner.stop();
  assert.equal(name, "Fix oauth callback");
});

test("named target spinner stop removes stacked duplicate frames", async () => {
  let name = "Fix oauth callback";

  const runtime: NamedTargetRuntime = {
    async getName() {
      return name;
    },
    async setName(_targetId, next) {
      name = next;
      return true;
    },
  };

  const spinner = createNamedTargetSpinner(runtime, { enabled: true, style: "braille", speed: "normal" });
  await spinner.start("@1");

  // An interrupted run left its frame behind and the next spinner painted over
  // it, producing the observed "<frame> <frame> title" double prefix.
  name = `⠙ ${name}`;
  assert.equal(name, "⠙ ⠋ Fix oauth callback");

  await spinner.stop();
  assert.equal(name, "Fix oauth callback");
});

test("named target spinner stop does not reject when the restore rename fails", async () => {
  let name = "Fix oauth callback";
  let writes = 0;

  const runtime: NamedTargetRuntime = {
    async getName() {
      return name;
    },
    async setName(_targetId, next) {
      writes += 1;
      if (writes > 1) throw new Error("socket lost");
      name = next;
      return true;
    },
  };

  const spinner = createNamedTargetSpinner(runtime, { enabled: true, style: "braille", speed: "normal" });
  await spinner.start("@1");

  await spinner.stop();
  assert.equal(name, "⠋ Fix oauth callback");
});

test("the first tick strips a stale frame left behind by a killed run", async () => {
  let name = "⠏ Fix oauth callback";

  const runtime: NamedTargetRuntime = {
    async getName() {
      return name;
    },
    async setName(_targetId, next) {
      name = next;
      return true;
    },
  };

  const spinner = createNamedTargetSpinner(runtime, { enabled: true, style: "braille", speed: "normal" });
  await spinner.start("@1");
  assert.equal(name, "⠋ Fix oauth callback");

  await spinner.stop();
  assert.equal(name, "Fix oauth callback");
});

test("stripSpinnerFrames strips stacked frames but leaves plausible titles alone", () => {
  assert.equal(stripSpinnerFrames("⠙ ⠋ Resolve CodeRabbit comments"), "Resolve CodeRabbit comments");
  assert.equal(stripSpinnerFrames("⣾ Loading data"), "Loading data");
  // classic frames are plain ASCII and can be real title text.
  assert.equal(stripSpinnerFrames("- looks like a flag"), "- looks like a flag");
  assert.equal(stripSpinnerFrames("Plain title"), "Plain title");
});
