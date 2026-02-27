import type { Query, SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

export interface ClaudeResponse {
  sessionId: string;
  text: string;
  isError: boolean;
  costUsd: number;
}

/**
 * Consume the full async generator from a Claude Code query,
 * capturing the session_id from the init message and the final result text.
 */
export async function consumeResponse(
  generator: Query,
): Promise<ClaudeResponse> {
  let sessionId = "";
  let result: SDKResultMessage | undefined;

  for await (const message of generator) {
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
