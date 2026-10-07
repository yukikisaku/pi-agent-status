import assert from "node:assert/strict";
import test from "node:test";

import { isZedTerminal } from "../index.ts";

test("Zed sets TERM_PROGRAM and ZED_TERM in its terminal", () => {
  assert.equal(isZedTerminal({ TERM_PROGRAM: "zed" }), true);
  assert.equal(isZedTerminal({ ZED_TERM: "true" }), true);
});

test("other terminals are ignored", () => {
  assert.equal(isZedTerminal({}), false);
  assert.equal(isZedTerminal({ TERM_PROGRAM: "WezTerm" }), false);
});

// tmux rewrites TERM_PROGRAM to "tmux" and can hand down a stale ZED_TERM from
// whichever client started the server, so $TMUX always wins.
test("inside tmux this extension stands down", () => {
  assert.equal(isZedTerminal({ TMUX: "/tmp/tmux-1000/default,123,0", ZED_TERM: "true" }), false);
  assert.equal(isZedTerminal({ TMUX: "/tmp/tmux-1000/default,123,0", TERM_PROGRAM: "zed" }), false);
});
