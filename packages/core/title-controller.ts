import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  buildConversationNamingSource,
  compactTitle,
  describeRenameFailure,
  generateTitle,
  type NamingConfig,
  type NamingSource,
  type RenameFailureReason,
} from "./naming.ts";

export type AnyContext = ExtensionContext | ExtensionCommandContext;

export type TitleTabPush = (
  title: string,
  ctx: AnyContext,
) => Promise<string | undefined> | string | undefined;

export type RenameResult =
  | { ok: true; title: string }
  | { ok: false; reason: RenameFailureReason; detail?: string };

/** How often the external session-name watcher polls for renames it cannot observe (ms). */
export const DEFAULT_EXTERNAL_NAME_POLL_MS = 1000;

export type TitleControllerOptions = {
  pi: ExtensionAPI;
  getNaming: () => NamingConfig;
  /** Push the title everywhere this host can show it. Returns the applied title. */
  applyTitle: (title: string, ctx: AnyContext) => Promise<string | undefined> | string | undefined;
  /**
   * Push only the host-side tab label (no session-name write). Receives an already
   * normalized title. Used when the session name was changed outside this extension
   * and the label merely needs to follow; falls back to `applyTitle` when omitted.
   */
  pushTabTitle?: TitleTabPush;
  /**
   * Poll period for the external session-name watcher. Hosts such as Oh My Pi
   * rename sessions through builtins that fire no extension-visible event, so
   * renames are detected by re-reading `pi.getSessionName()` on this interval.
   * 0 disables the watcher entirely. Defaults to 1000ms.
   */
  externalNamePollMs?: number;
};

export function notify(ctx: AnyContext, message: string, level: "info" | "error"): void {
  if (!ctx.hasUI) return;
  ctx.ui.notify(message, level);
}

export function createTitleController(options: TitleControllerOptions) {
  /** Title this extension last applied to the session; less-typed than the boolean it replaces. */
  let appliedTitle: string | undefined;
  /** Title passed to `applyTitle` but not yet applied; guards the async gap in event dispatch. */
  let titleInProgress: string | undefined;
  let hasAttemptedTitleForSession = false;
  let renameInFlight: Promise<RenameResult> | null = null;
  let sessionEpoch = 0;

  // External renames are polled when the host does not announce them: Oh My Pi
  // renames sessions through builtins and has no rename event for extensions.
  let externalNameCtx: AnyContext | undefined;
  let externalNameTimer: ReturnType<typeof setInterval> | null = null;
  let externalNameInFlight = false;

  const persistTitle = async (title: string, ctx: AnyContext): Promise<string | undefined> => {
    // Recorded before the push: `applyTitle` writes the session name first, and
    // the rename event it fires can reach this extension while the push to the
    // tab is still awaiting completion.
    titleInProgress = title;
    try {
      const applied = await options.applyTitle(title, ctx);
      if (!applied) return undefined;

      appliedTitle = applied;
      hasAttemptedTitleForSession = true;
      return applied;
    } finally {
      titleInProgress = undefined;
    }
  };

  const normalizeTitle = (title: string | undefined): string | undefined =>
    compactTitle(title ?? "", options.getNaming().maxChars);

  /**
   * Mirror a session name changed outside this extension (host builtin /rename
   * or /name, another extension, an auto-title) onto the host tab. The host
   * already persisted the name, so nothing is written back to the session.
   */
  const applyExternalTitle = async (name: string | undefined, ctx: AnyContext): Promise<boolean> => {
    const normalized = normalizeTitle(name);
    if (!normalized || normalized === appliedTitle || normalized === titleInProgress) return false;

    // A hand-picked title owns the label; a rename still being generated must
    // not overwrite it afterwards.
    sessionEpoch += 1;
    renameInFlight = null;

    const push = options.pushTabTitle ?? options.applyTitle;
    const applied = await push(normalized, ctx);
    if (!applied) return false;

    appliedTitle = applied;
    hasAttemptedTitleForSession = true;
    return true;
  };

  const watchTick = async (): Promise<void> => {
    if (externalNameTimer === null || externalNameInFlight || !externalNameCtx) return;
    externalNameInFlight = true;
    try {
      await applyExternalTitle(options.pi.getSessionName(), externalNameCtx);
    } catch {
      // A failing poll must stay silent; the next tick retries.
    } finally {
      externalNameInFlight = false;
    }
  };

  const stopSessionNameWatch = (): void => {
    if (externalNameTimer !== null) clearInterval(externalNameTimer);
    externalNameTimer = null;
    externalNameCtx = undefined;
  };

  const runRename = async (
    prompt: string | undefined,
    source: NamingSource,
    ctx: AnyContext,
    force = false,
  ): Promise<RenameResult> => {
    const naming = options.getNaming();
    if (!naming.enabled) return { ok: false, reason: "skipped" };

    if (!force && (appliedTitle !== undefined || hasAttemptedTitleForSession || renameInFlight)) {
      return { ok: false, reason: "skipped" };
    }

    const seed = prompt?.trim();
    if (!seed) {
      return { ok: false, reason: "missing_prompt" };
    }

    if (!force) {
      hasAttemptedTitleForSession = true;
    }

    const currentEpoch = sessionEpoch;
    const work = (async (): Promise<RenameResult> => {
      const result = await generateTitle(seed, source, ctx as ExtensionContext, naming);
      if (!result.ok) return result;

      if (currentEpoch !== sessionEpoch) {
        return { ok: false, reason: "stale_session" };
      }

      const title = await persistTitle(result.title, ctx);
      if (!title) {
        return { ok: false, reason: "invalid_output" };
      }

      return { ok: true, title };
    })();

    const inFlight = work.finally(() => {
      if (renameInFlight === inFlight) {
        renameInFlight = null;
      }
    });

    renameInFlight = inFlight;
    return inFlight;
  };

  return {
    reset(): void {
      sessionEpoch += 1;
      appliedTitle = undefined;
      hasAttemptedTitleForSession = false;
      renameInFlight = null;
      stopSessionNameWatch();
    },

    /** Reapply the name a resumed session already has instead of generating a new one. */
    async restoreExistingTitle(ctx: AnyContext): Promise<boolean> {
      const naming = options.getNaming();
      if (!naming.enabled) return false;

      const existing = compactTitle(options.pi.getSessionName() ?? "", naming.maxChars);
      if (!existing) return false;

      // The session already carries this name, so only the host tab needs it;
      // re-persisting would append a duplicate session-name entry every resume.
      const push = options.pushTabTitle ?? options.applyTitle;
      const applied = await push(existing, ctx);
      if (!applied) return false;

      appliedTitle = applied;
      hasAttemptedTitleForSession = true;
      return true;
    },

    applyExternalTitle,

    /** Poll `pi.getSessionName()` for external renames (hosts without a rename event). */
    startSessionNameWatch(ctx: AnyContext): void {
      if (externalNameTimer) return;

      const intervalMs = options.externalNamePollMs ?? DEFAULT_EXTERNAL_NAME_POLL_MS;
      if (!intervalMs || intervalMs <= 0) return;

      externalNameCtx = ctx;
      externalNameTimer = setInterval(() => {
        void watchTick();
      }, intervalMs);
      // A background poll must never keep the process alive.
      externalNameTimer.unref?.();
    },

    stopSessionNameWatch,

    async applyAutoTitle(seedPrompt: string | undefined, ctx: AnyContext): Promise<void> {
      if (await this.restoreExistingTitle(ctx)) return;
      await runRename(seedPrompt, "user_message", ctx);
    },

    async renameCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
      await ctx.waitForIdle();
      if (renameInFlight) await renameInFlight;

      const naming = options.getNaming();

      if (args.trim()) {
        const explicitTitle = compactTitle(args, naming.maxChars);
        if (!explicitTitle) {
          notify(ctx, "Usage: /rename [title]", "error");
          return;
        }

        const title = await persistTitle(explicitTitle, ctx);
        if (!title) {
          notify(ctx, "Invalid title.", "error");
          return;
        }

        notify(ctx, `Renamed title: ${title}`, "info");
        return;
      }

      const conversation = buildConversationNamingSource(ctx.sessionManager.getBranch());
      const result = await runRename(conversation, "conversation", ctx, true);

      if (!result.ok) {
        notify(ctx, describeRenameFailure(result.reason, result.detail), "error");
        return;
      }

      notify(ctx, `Renamed title: ${result.title}`, "info");
    },
  };
}
