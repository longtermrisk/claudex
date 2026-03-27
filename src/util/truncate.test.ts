import { describe, it, expect } from "vitest";
import { truncateContent, estimateTokens } from "./truncate.js";

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("estimates ~1 token per 4 chars", () => {
    // 100 chars → 25 tokens
    expect(estimateTokens("a".repeat(100))).toBe(25);
  });

  it("rounds up partial tokens", () => {
    // 5 chars → ceil(5/4) = 2 tokens
    expect(estimateTokens("hello")).toBe(2);
  });
});

describe("truncateContent", () => {
  it("returns content unchanged when within limit", () => {
    const small = "hello world";
    expect(truncateContent(small)).toBe(small);
  });

  it("returns content unchanged when exactly at limit", () => {
    // 100k tokens × 4 chars = 400k chars
    const exact = "x".repeat(400_000);
    expect(truncateContent(exact)).toBe(exact);
  });

  it("truncates content exceeding the limit and prepends a warning", () => {
    const big = "A".repeat(500_000); // ~125k tokens, over the 100k default
    const result = truncateContent(big, { label: "test content" });

    expect(result).toContain("⚠️ TRUNCATED");
    expect(result).toContain("test content");
    expect(result).toContain("125,000 tokens");
    // The kept portion should be 400k chars (100k tokens × 4)
    // plus the warning header
    expect(result.length).toBeLessThan(big.length);
    // Should end with the tail of the original (last 400k chars)
    expect(result.endsWith("A".repeat(400_000))).toBe(true);
  });

  it("keeps the last portion by default", () => {
    // Create content where start and end differ
    const content = "START" + "x".repeat(500_000) + "END";
    const result = truncateContent(content);

    expect(result).toContain("END");
    expect(result).not.toContain("START");
  });

  it("keeps the first portion when keep='first'", () => {
    const content = "START" + "x".repeat(500_000) + "END";
    const result = truncateContent(content, { keep: "first" });

    expect(result).toContain("START");
    expect(result).not.toContain("END");
    expect(result).toContain("first");
  });

  it("respects custom maxTokens", () => {
    const content = "x".repeat(100); // 25 tokens at 4 chars/token
    // Set limit to 10 tokens (40 chars)
    const result = truncateContent(content, { maxTokens: 10 });

    expect(result).toContain("⚠️ TRUNCATED");
    expect(result).toContain("25 tokens");
    // Warning + 40 chars of content
    const lines = result.split("---\n");
    expect(lines[1]).toBe("x".repeat(40));
  });

  it("uses 'content' as default label", () => {
    const big = "x".repeat(500_000);
    const result = truncateContent(big);

    expect(result).toContain("Original content was");
  });

  it("includes character count in warning", () => {
    const big = "x".repeat(500_000);
    const result = truncateContent(big, { label: "channel history" });

    expect(result).toContain("500,000 chars");
    expect(result).toContain("channel history");
  });
});
