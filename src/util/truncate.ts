/**
 * Content truncation utility.
 *
 * Prevents oversized tool outputs from filling the Claude context window.
 * Uses the Anthropic token counting API for accurate counts, with a
 * conservative heuristic fast-path for clearly-under-limit content.
 *
 * Default strategy: "both" — keeps first 50% + last 50% of content,
 * separated by a truncation marker. This preserves structure/headers
 * from the beginning and the most recent content from the end.
 *
 * All cut points are snapped to the nearest space to avoid mid-word splits.
 */

import { countTokensInText } from "./token-counter.js";

/** Conservative chars-per-token estimate for the fast pre-check */
const CHARS_PER_TOKEN = 3;

/** Default maximum tokens to keep when truncating (matches microcompaction budget) */
const DEFAULT_MAX_TOKENS = 20_000;

/** Convert a character count to an approximate token count */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export interface TruncateOptions {
  /** Maximum tokens to keep (default 20 000) */
  maxTokens?: number;
  /** Human-readable label for the content source (e.g. "channel history", "thread") */
  label?: string;
  /**
   * Which portion to keep when truncating:
   * - "both"  (default) — first 50% + last 50%, joined by a truncation marker
   * - "last"  — most recent content (tail)
   * - "first" — earliest content (head)
   */
  keep?: "first" | "last" | "both";
}

/** Snap a position backward to the previous space (for end-of-kept-region cuts) */
function snapBack(text: string, pos: number): number {
  if (pos >= text.length) return text.length;
  if (pos <= 0) return 0;
  const idx = text.lastIndexOf(" ", pos);
  return idx > 0 ? idx : pos;
}

/** Snap a position forward to the next space (for start-of-kept-region cuts) */
function snapForward(text: string, pos: number): number {
  if (pos <= 0) return 0;
  if (pos >= text.length) return text.length;
  const idx = text.indexOf(" ", pos);
  return idx >= 0 ? idx + 1 : pos;
}

/**
 * Truncate content to approximately `maxTokens` tokens.
 *
 * If the content is within limits it is returned unchanged.
 * Otherwise the content is trimmed, a warning header is prepended explaining
 * the original size and what was kept, and Claude is advised to use more
 * targeted tool calls.
 */
export async function truncateContent(
  content: string,
  options: TruncateOptions = {},
): Promise<string> {
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const label = options.label ?? "content";
  const keep = options.keep ?? "both";

  // Fast pre-check: if clearly under budget with conservative estimate, skip API call
  if (content.length <= maxTokens * CHARS_PER_TOKEN * 0.5) {
    return content;
  }

  // Accurate token count via API (falls back to heuristic on error)
  const actualTokens = await countTokensInText(content, maxTokens);

  if (actualTokens <= maxTokens) {
    return content;
  }

  // Target character count proportional to actual token density
  const targetChars = Math.floor((maxTokens / actualTokens) * content.length);
  const removedTokens = actualTokens - maxTokens;

  let body: string;

  if (keep === "both") {
    const halfChars = Math.floor(targetChars / 2);
    const firstEnd = snapBack(content, halfChars);
    const lastStart = snapForward(content, content.length - halfChars);
    const firstHalf = content.slice(0, firstEnd);
    const lastHalf = content.slice(lastStart);
    const separator = `\n[...TRUNCATED: ~${removedTokens.toLocaleString()} tokens removed from middle...]\n`;
    body = firstHalf + separator + lastHalf;
  } else if (keep === "last") {
    const start = content.length - targetChars;
    const snappedStart = snapForward(content, start);
    body = content.slice(snappedStart);
  } else {
    // "first"
    const snappedEnd = snapBack(content, targetChars);
    body = content.slice(0, snappedEnd);
  }

  const portionDesc =
    keep === "both" ? "first + last halves" : `${keep} portion`;

  const warning =
    `⚠️ TRUNCATED: Original ${label} was ~${actualTokens.toLocaleString()} tokens ` +
    `(${content.length.toLocaleString()} chars). ` +
    `Showing ~${maxTokens.toLocaleString()} tokens (${portionDesc}).\n` +
    `💡 Use more targeted tool calls to reduce output size ` +
    `(e.g. narrower time ranges, specific keywords, fewer results).\n` +
    `---\n`;

  return warning + body;
}
