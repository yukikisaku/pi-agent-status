import assert from "node:assert/strict";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createHerdrClient } from "../herdr-client.ts";

type Handler = (method: string, params: Record<string, unknown>) => unknown;

async function withFakeHerdr(handler: Handler, run: (env: NodeJS.ProcessEnv) => Promise<void>) {
  const name = `pi-herdr-test-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const socketPath = process.platform === "win32" ? name : join(tmpdir(), name);
  const listenPath = process.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;

  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const request = JSON.parse(buffer.slice(0, newline)) as {
          id: string;
          method: string;
          params: Record<string, unknown>;
        };
        buffer = buffer.slice(newline + 1);
        socket.write(`${JSON.stringify({ id: request.id, result: handler(request.method, request.params) })}\n`);
        newline = buffer.indexOf("\n");
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(listenPath, resolve));

  try {
    await run({ HERDR_ENV: "1", HERDR_SOCKET_PATH: socketPath, HERDR_TAB_ID: "w9:t2" });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("the client is unavailable outside herdr", () => {
  assert.equal(createHerdrClient({}).isAvailable(), false);
  assert.equal(createHerdrClient({ HERDR_ENV: "1" }).isAvailable(), false);
  assert.equal(createHerdrClient({ HERDR_ENV: "1", HERDR_SOCKET_PATH: "x" }).isAvailable(), false);
});

test("the tab label is read, renamed, and cached", async () => {
  let label = "1";
  const methods: string[] = [];

  await withFakeHerdr(
    (method, params) => {
      methods.push(method);
      if (method === "tab.rename") label = params.label as string;
      return { type: "tab_info", tab: { tab_id: "w9:t2", label, focused: true } };
    },
    async (env) => {
      const client = createHerdrClient(env);
      assert.equal(client.isAvailable(), true);

      assert.equal(await client.getName("w9:t2"), "1");
      assert.equal(await client.setName("w9:t2", "Fix OAuth callback"), true);

      // The rename response refreshes the cache, so no extra tab.get is needed.
      assert.equal(await client.getName("w9:t2"), "Fix OAuth callback");
      assert.deepEqual(methods, ["tab.get", "tab.rename"]);
    },
  );
});

test("tab focus is reported as target visibility", async () => {
  let focused = false;

  await withFakeHerdr(
    () => ({ type: "tab_info", tab: { tab_id: "w9:t2", label: "1", focused } }),
    async (env) => {
      const client = createHerdrClient(env);
      assert.equal(await client.isTargetVisible("w9:t2"), false);

      focused = true;
      assert.equal(await client.isTargetVisible("w9:t2"), true);

      // Herdr exposes no window-level focus, so the app always counts as focused.
      assert.equal(await client.isAppFocused(), true);
    },
  );
});

test("an unreachable socket degrades to empty values instead of throwing", async () => {
  const client = createHerdrClient({
    HERDR_ENV: "1",
    HERDR_SOCKET_PATH: `pi-herdr-missing-${Math.random().toString(36).slice(2)}`,
    HERDR_TAB_ID: "w9:t2",
  });

  assert.equal(await client.getName("w9:t2"), "");
  assert.equal(await client.setName("w9:t2", "anything"), false);
  assert.equal(await client.isTargetVisible("w9:t2"), true);
});

test("a failed rename invalidates the cached label", async () => {
  let label = "⠋ Stale frame";
  let failRename = true;
  const methods: string[] = [];

  await withFakeHerdr(
    (method, params) => {
      methods.push(method);
      if (method === "tab.rename") {
        // Simulate a rename whose response never reaches the client.
        if (failRename) return undefined;
        label = params.label as string;
      }
      return { type: "tab_info", tab: { tab_id: "w9:t2", label, focused: true } };
    },
    async (env) => {
      const client = createHerdrClient(env);

      assert.equal(await client.getName("w9:t2"), "⠋ Stale frame");
      assert.equal(await client.setName("w9:t2", "Stale frame"), false);

      failRename = false;
      // The next read must refetch from the daemon, not serve the stale cache.
      assert.equal(await client.getName("w9:t2"), "⠋ Stale frame");
      assert.deepEqual(methods, ["tab.get", "tab.rename", "tab.get"]);
    },
  );
});

test("a failed fetch is not cached as an empty label", async () => {
  const label = "Real title";
  let failNextGet = true;
  const methods: string[] = [];

  await withFakeHerdr(
    (method) => {
      methods.push(method);
      if (method === "tab.get" && failNextGet) {
        failNextGet = false;
        return undefined;
      }
      return { type: "tab_info", tab: { tab_id: "w9:t2", label, focused: true } };
    },
    async (env) => {
      const client = createHerdrClient(env);

      assert.equal(await client.getName("w9:t2"), "");
      assert.equal(await client.getName("w9:t2"), "Real title");
      assert.deepEqual(methods, ["tab.get", "tab.get"]);
    },
  );
});
