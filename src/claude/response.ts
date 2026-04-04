import type { Query, SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

export interface ClaudeResponse {
  sessionId: string;
  text: string;
  isError: boolean;
  /** SDK result subtype when not 'success' — e.g. 'error_max_turns' */
  subtype?: string;
  /** true if token-based auto-compaction fired at least once during this session */
  didAutoCompact?: boolean;
  costUsd: number;
  /**
   * Input tokens from the primary model's usage at end of session.
   * This is the cumulative input tokens across all turns (billing metric).
   * Combined with contextWindowSize, gives a sense of context utilisation.
   */
  contextTokens?: number;
  /** The primary model's maximum context window capacity (e.g. 200 000). */
  contextWindowSize?: number;
  /** Token count in context just before auto-compaction fired (from compact_boundary). */
  compactionPreTokens?: number;
}

/**
 * Default inactivity timeout (ms). Can be overridden via CLAUDE_INACTIVITY_TIMEOUT_MS env var.
 * If no SDK message is yielded for this duration, the generator is aborted.
 */
export const DEFAULT_INACTIVITY_TIMEOUT_MS =
  parseInt(process.env.CLAUDE_INACTIVITY_TIMEOUT_MS ?? "") || 10 * 60 * 1000; // 10 minutes

/**
 * Consume the full async generator from a Claude Code query,
 * capturing the session_id from the init message and the final result text.
 *
 * Includes an inactivity timeout: if no message is yielded for the duration
 * returned by getTimeoutMs(), the generator is aborted and an error is returned.
 * getTimeoutMs() is re-evaluated on every iteration, so it can be updated mid-stream
 * (e.g. via the set_inactivity_timeout MCP tool).
 */
export async function consumeResponse(
  generator: Query,
  getTimeoutMs: () => number = () => DEFAULT_INACTIVITY_TIMEOUT_MS,
): Promise<ClaudeResponse> {
  let sessionId = "";
  let result: SDKResultMessage | undefined;
  let didAutoCompact = false;
  let compactionPreTokens: number | undefined;

  for await (const message of withInactivityTimeout(generator, getTimeoutMs)) {
    const msg = message as SDKMessage & { session_id?: string };

    // Capture session_id from init message
    if (msg.type === "system" && "subtype" in msg && msg.subtype === "init") {
      sessionId = msg.session_id ?? "";
    }

    // Detect token-based auto-compaction (fires when context window fills up)
    if (msg.type === "system" && "subtype" in msg && msg.subtype === "compact_boundary") {
      didAutoCompact = true;
      const meta = (msg as { compact_metadata?: { pre_tokens?: number } }).compact_metadata;
      if (meta?.pre_tokens != null) {
        compactionPreTokens = meta.pre_tokens;
      }
    }

    // Capture the final result
    if (msg.type === "result") {
      result = msg as SDKResultMessage;
      sessionId = result.session_id || sessionId;
    }
  }

  if (!result) {
    return { sessionId, text: "No response received from Claude.", isError: true, costUsd: 0 };
  }

  // Extract context window usage from per-model usage stats
  let contextTokens: number | undefined;
  let contextWindowSize: number | undefined;
  const modelUsage = (result as unknown as { modelUsage?: Record<string, { inputTokens: number; contextWindow: number }> }).modelUsage;
  if (modelUsage) {
    const entries = Object.values(modelUsage);
    if (entries.length > 0) {
      // Pick the model with the most input tokens (primary model)
      const primary = entries.reduce((a, b) => a.inputTokens > b.inputTokens ? a : b);
      contextTokens = primary.inputTokens;
      contextWindowSize = primary.contextWindow;
    }
  }

  if (result.subtype === "success") {
    return {
      sessionId,
      text: result.result || "Done (no text output).",
      isError: false,
      didAutoCompact,
      costUsd: result.total_cost_usd,
      contextTokens,
      contextWindowSize,
      compactionPreTokens,
    };
  }

  // Error result
  return {
    sessionId,
    text: `Error: ${result.errors?.join(", ") ?? result.subtype}`,
    isError: true,
    subtype: result.subtype,
    didAutoCompact,
    costUsd: result.total_cost_usd,
    contextTokens,
    contextWindowSize,
    compactionPreTokens,
  };
}

/**
 * Wraps an async iterable with an inactivity timeout.
 * If the source doesn't yield a value within the duration returned by getTimeoutMs(),
 * iteration ends and the underlying generator is closed.
 * getTimeoutMs() is called on every iteration so the timeout can be updated mid-stream.
 */
async function* withInactivityTimeout<T>(
  source: AsyncIterable<T>,
  getTimeoutMs: () => number,
): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();
  try {
    while (true) {
      const timeoutMs = getTimeoutMs();
      const raceResult = await Promise.race([
        iterator.next(),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), timeoutMs)),
      ]);

      if (raceResult === "timeout") {
        console.error(`[consumeResponse] No activity for ${timeoutMs / 1000}s — aborting stuck generator`);
        return;
      }

      const { value, done } = raceResult as IteratorResult<T>;
      if (done) return;
      yield value;
    }
  } finally {
    await iterator.return?.();
  }
}
