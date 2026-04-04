import { vi, describe, it, expect, beforeEach } from "vitest";

// Mock the token counter so truncate tests run without a real API key.
// vi.mock() is hoisted, so this runs before any imports below.
vi.mock("./token-counter.js", () => ({
  countTokensInText: vi.fn(),
}));

import { truncateContent, estimateTokens } from "./truncate.js";
import { countTokensInText } from "./token-counter.js";

const mockCount = vi.mocked(countTokensInText);

// We use maxTokens:100 in most tests so that the fast-path threshold
// (100 * 3 * 0.5 = 150 chars) is small and easy to work around with short strings.
const LIMIT = 100;
const THRESHOLD = LIMIT * 3 * 0.5; // 150 chars — content must exceed this to hit mock

// A helper that builds content clearly over the fast-path threshold
function over(extra = 0): string {
  return "word ".repeat(Math.ceil((THRESHOLD + extra + 10) / 5));
}

describe("estimateTokens", () => {
  it("returns 0 for an empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("estimates ~1 token per 3 chars (rounds up)", () => {
    expect(estimateTokens("a".repeat(9))).toBe(3);
    expect(estimateTokens("a".repeat(10))).toBe(4); // ceil(10/3)
  });
});

describe("truncateContent", () => {
  beforeEach(() => {
    // Default: API says content is under the 100-token limit → no truncation
    mockCount.mockResolvedValue(50);
  });

  // ── Under limit ─────────────────────────────────────────────────────────────

  it("returns content unchanged when clearly under the fast-path threshold", async () => {
    const small = "hi"; // well under 150 chars
    const result = await truncateContent(small, { maxTokens: LIMIT });
    expect(result).toBe(small);
    expect(mockCount).not.toHaveBeenCalled();
  });

  it("returns content unchanged when API reports it is within the token limit", async () => {
    mockCount.mockResolvedValue(99); // just under LIMIT
    const content = over();
    const result = await truncateContent(content, { maxTokens: LIMIT });
    expect(result).toBe(content);
  });

  // ── Warning header ───────────────────────────────────────────────────────────

  it("prepends a warning when content is truncated", async () => {
    mockCount.mockResolvedValue(200); // 2× over limit
    const result = await truncateContent(over(), { maxTokens: LIMIT, label: "channel history" });
    expect(result).toContain("⚠️ TRUNCATED");
    expect(result).toContain("channel history");
    expect(result).toContain("200");
    expect(result).toContain("100");
  });

  it("includes actionable guidance in the warning", async () => {
    mockCount.mockResolvedValue(200);
    const result = await truncateContent(over(), { maxTokens: LIMIT });
    expect(result).toContain("💡");
    expect(result).toContain("more targeted");
  });

  it("uses 'content' as the default label", async () => {
    mockCount.mockResolvedValue(200);
    const result = await truncateContent(over(), { maxTokens: LIMIT });
    expect(result).toContain("Original content");
  });

  // ── "both" strategy (default) ─────────────────────────────────────────────

  it("uses 'both' strategy by default", async () => {
    mockCount.mockResolvedValue(200);
    const content = "START " + "middle ".repeat(100) + " END";
    const result = await truncateContent(content, { maxTokens: LIMIT });
    expect(result).toContain("START");
    expect(result).toContain("END");
    expect(result).toContain("TRUNCATED");
    expect(result).toContain("tokens removed from middle");
  });

  it("places a truncation marker between the two halves", async () => {
    mockCount.mockResolvedValue(200);
    const content = "AAAA " + "x ".repeat(200) + " BBBB";
    const result = await truncateContent(content, { maxTokens: LIMIT });
    const markerIndex = result.indexOf("[...TRUNCATED:");
    const aIndex = result.indexOf("AAAA");
    const bIndex = result.indexOf("BBBB");
    expect(markerIndex).toBeGreaterThan(aIndex);
    expect(bIndex).toBeGreaterThan(markerIndex);
  });

  it("reports removed token count in the marker", async () => {
    mockCount.mockResolvedValue(200); // 200 actual, 100 kept → 100 removed
    const result = await truncateContent(over(), { maxTokens: LIMIT });
    expect(result).toContain("~100 tokens removed");
  });

  // ── "last" strategy ──────────────────────────────────────────────────────────

  it("keeps only the tail when keep='last'", async () => {
    mockCount.mockResolvedValue(200);
    const content = "START " + "x ".repeat(200) + "END";
    const result = await truncateContent(content, { maxTokens: LIMIT, keep: "last" });
    expect(result).toContain("END");
    expect(result).not.toContain("START");
  });

  // ── "first" strategy ─────────────────────────────────────────────────────────

  it("keeps only the head when keep='first'", async () => {
    mockCount.mockResolvedValue(200);
    const content = "START " + "x ".repeat(200) + " END";
    const result = await truncateContent(content, { maxTokens: LIMIT, keep: "first" });
    expect(result).toContain("START");
    expect(result).not.toContain("END");
  });

  // ── Word-boundary snapping ───────────────────────────────────────────────────

  it("does not cut in the middle of a word (both strategy)", async () => {
    mockCount.mockResolvedValue(200);
    const longWord = "superlongword";
    const content = (longWord + " ").repeat(200);
    const result = await truncateContent(content, { maxTokens: LIMIT });

    // Locate the truncation marker in the output
    const markerStart = result.indexOf("[...TRUNCATED:");
    const markerEnd = result.indexOf("]\n", markerStart) + 2;
    expect(markerStart).toBeGreaterThan(0);

    // Text ending just before the marker, text starting just after it
    const beforeMarker = result.slice(0, markerStart).trimEnd();
    const afterMarker = result.slice(markerEnd).trimStart();

    // Both sides should land on a complete word boundary
    const lastWordBefore = beforeMarker.split(/\s+/).at(-1);
    const firstWordAfter = afterMarker.split(/\s+/)[0];

    expect(lastWordBefore).toBe(longWord);
    expect(firstWordAfter).toBe(longWord);
  });

  it("does not cut in the middle of a word (last strategy)", async () => {
    mockCount.mockResolvedValue(200);
    const longWord = "foobarword";
    const content = (longWord + " ").repeat(200);
    const result = await truncateContent(content, { maxTokens: LIMIT, keep: "last" });
    const body = result.split("---\n").slice(1).join("---\n");
    // The very first characters of the kept region should be a complete word start
    const firstWord = body.trimStart().split(" ")[0];
    expect(firstWord).toBe(longWord);
  });

  // ── Token count accuracy ─────────────────────────────────────────────────────

  it("uses actual token count from API, not char estimate, for truncation decision", async () => {
    // Content is long enough to pass the fast-path (>150 chars) but API says it's under limit
    mockCount.mockResolvedValue(10); // API says only 10 tokens
    const longContent = "word ".repeat(50); // 250 chars, would fail char-based pre-check
    const result = await truncateContent(longContent, { maxTokens: LIMIT });
    expect(result).toBe(longContent); // no truncation since API says 10 < 100
    expect(mockCount).toHaveBeenCalled();
  });
});
