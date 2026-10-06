import net from "node:net";

const REQUEST_TIMEOUT_MS = 1500;

export type HerdrTab = {
  tab_id: string;
  label: string;
  focused: boolean;
};

export type HerdrClient = {
  isAvailable(): boolean;
  tabId(): string | undefined;
  getName(tabId: string): Promise<string>;
  setName(tabId: string, label: string): Promise<boolean>;
  isTargetVisible(tabId: string): Promise<boolean>;
  isAppFocused(): Promise<boolean>;
  refresh(tabId: string): Promise<void>;
};

function socketEndpoint(env: NodeJS.ProcessEnv): string | undefined {
  const socketPath = env.HERDR_SOCKET_PATH;
  if (!socketPath) return undefined;
  return process.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;
}

function sendRequest(endpoint: string, method: string, params: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    const socket = net.createConnection(endpoint);
    let buffer = "";
    let settled = false;

    const finish = (value: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };

    const timer = setTimeout(() => finish(undefined), REQUEST_TIMEOUT_MS);
    timer.unref?.();

    socket.on("error", () => finish(undefined));
    socket.on("end", () => finish(undefined));
    socket.on("connect", () => {
      const id = `pi-herdr:${Date.now()}:${Math.random().toString(36).slice(2)}`;
      socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;

      try {
        const response = JSON.parse(buffer.slice(0, newline)) as { result?: unknown };
        finish(response.result);
      } catch {
        finish(undefined);
      }
    });
  });
}

export function createHerdrClient(env: NodeJS.ProcessEnv = process.env): HerdrClient {
  const endpoint = socketEndpoint(env);
  const tabId = env.HERDR_TAB_ID;
  const available = env.HERDR_ENV === "1" && !!endpoint && !!tabId;

  // The spinner repaints several times a second; caching the label we last wrote
  // keeps that to one socket round trip per frame instead of two.
  let cachedLabel: string | undefined;

  const fetchTab = async (target: string): Promise<HerdrTab | undefined> => {
    const result = (await sendRequest(endpoint!, "tab.get", { tab_id: target })) as
      | { tab?: HerdrTab }
      | undefined;
    return result?.tab;
  };

  return {
    isAvailable: () => available,
    tabId: () => tabId,

    async getName(target: string): Promise<string> {
      if (cachedLabel !== undefined) return cachedLabel;
      const tab = await fetchTab(target);
      // Do not cache failures: a transient error must not masquerade as an
      // empty label, or the next spinner tick would paint over the real one.
      if (!tab) return "";
      cachedLabel = tab.label;
      return cachedLabel;
    },

    async setName(target: string, label: string): Promise<boolean> {
      const result = (await sendRequest(endpoint!, "tab.rename", { tab_id: target, label })) as
        | { tab?: HerdrTab }
        | undefined;
      if (!result?.tab) {
        // The daemon state is unknown now; force the next read to refetch
        // instead of serving a label that may no longer match.
        cachedLabel = undefined;
        return false;
      }

      cachedLabel = result.tab.label;
      return true;
    },

    async isTargetVisible(target: string): Promise<boolean> {
      const tab = await fetchTab(target);
      if (!tab) return true;
      cachedLabel = tab.label;
      return tab.focused;
    },

    // Herdr exposes no window-level focus state, so a focused tab counts as visible.
    async isAppFocused(): Promise<boolean> {
      return true;
    },

    async refresh(target: string): Promise<void> {
      const tab = await fetchTab(target);
      cachedLabel = tab?.label;
    },
  };
}
