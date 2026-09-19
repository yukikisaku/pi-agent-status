import type { ThinkingLevel, UserMessage } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

const REQUEST_TIMEOUT_MS = 30_000;
const NAMING_SOURCE_CHAR_MAX = 4000;

export const DEFAULT_TITLE_MAX_CHARS = 32;

export type NamingSource = "user_message" | "conversation";

export type NamingConfig = {
  enabled: boolean;
  /** Empty means "use the model the session is already running on". */
  model: string;
  thinking: string;
  maxChars: number;
};

export type RenameFailureReason =
  | "missing_prompt"
  | "missing_model"
  | "missing_auth"
  | "request_failed"
  | "invalid_output"
  | "skipped"
  | "stale_session";

export type GenerateTitleResult =
  | { ok: true; title: string }
  | { ok: false; reason: Exclude<RenameFailureReason, "skipped" | "stale_session">; detail?: string };

const TITLE_PROMPT = `You name coding sessions.

Reply with exactly one line:
TITLE: <short title>

Rules:
- Write the title in the same language the user wrote in.
- Describe the concrete task, not the tooling.
- Keep it short enough to fit a terminal tab label.
- No quotes, no punctuation at the end, no emoji, no markdown, no extra labels or explanation.

Example:
TITLE: Fix OAuth callback`;

export function sanitizeTitle(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s"'`“”‘’]+|[\s"'`“”‘’]+$/g, "")
    .trim();
}

export function compactTitle(value: string, maxChars = DEFAULT_TITLE_MAX_CHARS): string | undefined {
  const title = sanitizeTitle(value);
  if (!title) return undefined;
  if (title.length <= maxChars) return title;
  return title.slice(0, maxChars).trim() || undefined;
}

function cleanGeneratedValue(value: string): string {
  return value
    .replace(/^\d+\.\s*/, "")
    .replace(/^[-*]\s*/, "")
    .replace(/^[\s"'`]+|[\s"'`]+$/g, "")
    .trim();
}

export function parseGeneratedTitle(value: string): { title?: string } {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const titleMatch = line.match(/title\s*:\s*(.*)$/i);
    if (titleMatch?.[1]) {
      return { title: cleanGeneratedValue(titleMatch[1]) };
    }
  }

  if (lines.length === 1) {
    return { title: cleanGeneratedValue(lines[0]!) };
  }

  return {};
}

function extractTextFromMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        !!part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part,
    )
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function normalizeUserPrompt(text: string): string | undefined {
  const prompt = text.replace(/^(?:<skill\b[^>]*>[\s\S]*?<\/skill>\s*)+/, "").trim();
  return prompt || undefined;
}

export function getFirstUserPrompt(
  entries: SessionEntry[],
  fallback?: string,
): string | undefined {
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    if (entry.message.role !== "user") continue;

    const prompt = normalizeUserPrompt(extractTextFromMessageContent(entry.message.content));
    if (prompt) return prompt;
  }

  return normalizeUserPrompt(fallback ?? "");
}

export function buildConversationNamingSource(entries: SessionEntry[]): string | undefined {
  const messages: string[] = [];

  for (const entry of entries) {
    if (entry.type !== "message") continue;

    const role = entry.message.role;
    if (role !== "user" && role !== "assistant") continue;

    const text = extractTextFromMessageContent(entry.message.content);
    if (!text) continue;

    messages.push(`<${role}>\n${text}\n</${role}>`);
  }

  const conversation = messages.join("\n\n").trim();
  return conversation || undefined;
}

function formatNamingPrompt(seed: string, source: NamingSource): string {
  const tag = source === "conversation" ? "conversation" : "user_message";
  const content = seed.trim().slice(0, NAMING_SOURCE_CHAR_MAX);

  return `<${tag}>\n${content}\n</${tag}>\n\nReply with:\nTITLE: <short title>`;
}

function parseModelSpec(modelSpec: string): { provider: string; modelId: string } | undefined {
  const [provider, ...modelParts] = modelSpec.split("/");
  const modelId = modelParts.join("/");
  if (!provider?.trim() || !modelId.trim()) return undefined;
  return { provider: provider.trim(), modelId: modelId.trim() };
}

const THINKING_LEVELS: ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh"];

export function normalizeThinkingLevel(value: string): ThinkingLevel | undefined {
  const level = value.trim().toLowerCase();
  return THINKING_LEVELS.find((candidate) => candidate === level);
}

export async function generateTitle(
  prompt: string,
  source: NamingSource,
  ctx: ExtensionContext,
  config: NamingConfig,
): Promise<GenerateTitleResult> {
  const seed = prompt.trim();
  if (!seed) {
    return { ok: false, reason: "missing_prompt" };
  }

  const model = resolveNamingModel(ctx, config.model);
  if (!model) {
    return { ok: false, reason: "missing_model" };
  }

  // Extension-registered providers (e.g. claude-bridge) stream through their own
  // implementation; pi-ai's global completeSimple only knows the builtin apis.
  const providerStream = ctx.modelRegistry.getRegisteredProviderConfig(model.provider)?.streamSimple;

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok && !providerStream) {
    return { ok: false, reason: "missing_auth", detail: auth.error };
  }

  const message: UserMessage = {
    role: "user",
    content: [{ type: "text", text: formatNamingPrompt(seed, source) }],
    timestamp: Date.now(),
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  const request = { systemPrompt: TITLE_PROMPT, messages: [message] };
  const options = {
    apiKey: auth.ok ? auth.apiKey : undefined,
    headers: auth.ok ? auth.headers : undefined,
    maxTokens: 64,
    reasoning: normalizeThinkingLevel(config.thinking),
    signal: controller.signal,
  };

  let response;
  try {
    response = providerStream
      ? await providerStream(model, request, options).result()
      : await completeSimple(model, request, options);
  } catch (error) {
    return { ok: false, reason: "request_failed", detail: describeError(error) };
  } finally {
    clearTimeout(timeoutId);
  }

  const generated = response.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");

  const parsed = parseGeneratedTitle(generated);
  const title = compactTitle(parsed.title ?? "", config.maxChars);

  if (!title) {
    return { ok: false, reason: "invalid_output" };
  }

  return { ok: true, title };
}

function resolveNamingModel(ctx: ExtensionContext, modelSpec: string) {
  const spec = modelSpec.trim();
  if (!spec) return ctx.model;

  const parsed = parseModelSpec(spec);
  if (!parsed) return undefined;

  return ctx.modelRegistry.find(parsed.provider, parsed.modelId) ?? ctx.model;
}

function describeError(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.trim() || undefined;
}

export function describeRenameFailure(reason: RenameFailureReason, detail?: string): string {
  const summary = renameFailureSummary(reason);
  return detail ? `${summary} (${detail})` : summary;
}

function renameFailureSummary(reason: RenameFailureReason): string {
  switch (reason) {
    case "missing_prompt":
      return "No user or assistant text found in the current branch.";
    case "missing_model":
      return "No model is available for title generation.";
    case "missing_auth":
      return "No request auth is available for the naming model.";
    case "request_failed":
      return "Title rename request failed.";
    case "invalid_output":
      return "The model returned an invalid title format.";
    case "stale_session":
      return "Session changed before rename completed.";
    case "skipped":
      return "Title rename was skipped.";
  }
}
