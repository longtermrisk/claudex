import type { Query, SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

export interface ClaudeResponse {
  sessionId: string;
  text: string;
  isError: boolean;
  costUsd: number;
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

  for await (const message of withInactivityTimeout(generator, getTimeoutMs)) {
    const msg = message as SDKMessage & { session_id?: string };

    // Capture session_id from init message
    if (msg.type === "system" && "subtype" in msg && msg.subtype === "init") {
      sessionId = msg.session_id ?? "";
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

  if (result.subtype === "success") {
    return {
      sessionId,
      text: result.result || "Done (no text output).",
      isError: false,
      costUsd: result.total_cost_usd,
    };
  }

  // Error result
  return {
    sessionId,
    text: `Error: ${result.errors?.join(", ") ?? result.subtype}`,
    isError: true,
    costUsd: result.total_cost_usd,
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
