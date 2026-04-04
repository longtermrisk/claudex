/**
 * Token counting utility using the Anthropic API for accurate counts.
 *
 * Uses a conservative heuristic fast-path to avoid API calls when content
 * is clearly under the limit. Falls back to the heuristic if the API is
 * unavailable (e.g. no API key in test environments).
 */

import Anthropic from "@anthropic-ai/sdk";

/** Conservative chars-per-token for the fast-path heuristic (code + JSON dense) */
const HEURISTIC_CHARS_PER_TOKEN = 3;

/** Model used for token counting (tokenizer is shared across Claude 3+ models) */
const COUNT_TOKENS_MODEL = "claude-3-5-haiku-20241022";

let _client: Anthropic | undefined;

function getClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic();
  }
  return _client;
}

/**
 * Count tokens in a text string using the Anthropic API.
 *
 * @param text - The text to count tokens for.
 * @param fastCheckLimitTokens - If > 0, skip the API call and return a heuristic
 *   estimate when the text is clearly under this limit (text.length / 3 < limit * 0.8).
 *   Pass your truncation limit here to avoid API calls for short content.
 * @returns Accurate token count (or conservative heuristic estimate on fast-path / error).
 */
export async function countTokensInText(
  text: string,
  fastCheckLimitTokens = 0,
): Promise<number> {
  if (!text) return 0;

  // Fast path: if conservative estimate is well under the limit, skip the API call
  if (
    fastCheckLimitTokens > 0 &&
    text.length / HEURISTIC_CHARS_PER_TOKEN < fastCheckLimitTokens * 0.8
  ) {
    return Math.ceil(text.length / HEURISTIC_CHARS_PER_TOKEN);
  }

  try {
    const response = await getClient().messages.countTokens({
      model: COUNT_TOKENS_MODEL,
      messages: [{ role: "user", content: text }],
    });
    return response.input_tokens;
  } catch {
    // Fallback: conservative heuristic (better to over-truncate than to throw)
    return Math.ceil(text.length / HEURISTIC_CHARS_PER_TOKEN);
  }
}
