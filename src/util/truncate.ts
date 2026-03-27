/**
 * Content truncation utility.
 *
 * Prevents oversized content from being appended to the Claude context.
 * When content exceeds the token limit, it keeps the *last* N tokens
 * (most recent content) and prepends a warning with the original size.
 */

/** Rough chars-per-token estimate (conservative for English + JSON) */
const CHARS_PER_TOKEN = 4;

/** Default maximum tokens to keep when truncating */
const DEFAULT_MAX_TOKENS = 100_000;

/** Convert a character count to an approximate token count */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export interface TruncateOptions {
  /** Maximum tokens to keep (default 100 000) */
  maxTokens?: number;
  /** Human-readable label for the content source (e.g. "channel history", "thread") */
  label?: string;
  /** Keep the "first" or "last" portion of the content (default "last") */
  keep?: "first" | "last";
}

/**
 * Truncate content to approximately `maxTokens` tokens.
 *
 * If the content is within limits, it is returned unchanged.
 * Otherwise, the content is trimmed and a warning header is prepended
 * describing the original size and how much was kept.
 *
 * @returns The (possibly truncated) content string.
 */
export function truncateContent(
  content: string,
  options: TruncateOptions = {},
): string {
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const label = options.label ?? "content";
  const keep = options.keep ?? "last";
  const maxChars = maxTokens * CHARS_PER_TOKEN;

  if (content.length <= maxChars) {
    return content;
  }

  const originalTokens = estimateTokens(content);

  const truncated =
    keep === "last"
      ? content.slice(-maxChars)
      : content.slice(0, maxChars);

  const direction = keep === "last" ? "last" : "first";

  const warning =
    `⚠️ TRUNCATED: Original ${label} was ~${originalTokens.toLocaleString()} tokens ` +
    `(${content.length.toLocaleString()} chars). ` +
    `Showing ${direction} ~${maxTokens.toLocaleString()} tokens only.\n` +
    `---\n`;

  return warning + truncated;
}
