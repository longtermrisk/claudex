import { vi, describe, it, expect, beforeEach } from "vitest";

/**
 * We mock @anthropic-ai/sdk at the module level (hoisted).
 * All Anthropic instances share the same `mockCountTokens` fn object,
 * so per-test behavior is controlled via mockResolvedValue / mockRejectedValue.
 *
 * Note: token-counter.ts caches a singleton `_client`.  Because `mockCountTokens`
 * is the same reference in every instance, updating its return value between tests
 * affects all subsequent calls regardless of which instance holds the reference.
 */
const mockCountTokens = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  // Use a class so vitest doesn't warn about non-function constructors
  default: class MockAnthropic {
    messages = { countTokens: mockCountTokens };
  },
}));

import { countTokensInText } from "./token-counter.js";

describe("countTokensInText", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCountTokens.mockResolvedValue({ input_tokens: 100 });
  });

  it("returns 0 for an empty string without calling the API", async () => {
    const result = await countTokensInText("");
    expect(result).toBe(0);
    expect(mockCountTokens).not.toHaveBeenCalled();
  });

  it("calls the API and returns the accurate token count", async () => {
    mockCountTokens.mockResolvedValue({ input_tokens: 42 });
    const result = await countTokensInText("hello world");
    expect(result).toBe(42);
    expect(mockCountTokens).toHaveBeenCalledOnce();
  });

  it("uses the heuristic fast-path when content is clearly under the limit", async () => {
    // 60 chars / 3 = 20 tokens; 20 < 100 * 0.8 = 80  →  skip API
    const text = "a".repeat(60);
    const result = await countTokensInText(text, 100);
    expect(result).toBe(Math.ceil(60 / 3)); // heuristic: 20
    expect(mockCountTokens).not.toHaveBeenCalled();
  });

  it("calls the API when content is at the fast-path boundary", async () => {
    mockCountTokens.mockResolvedValue({ input_tokens: 95 });
    // 300 chars / 3 = 100 tokens; 100 is NOT < 100 * 0.8 = 80  →  call API
    const text = "a".repeat(300);
    const result = await countTokensInText(text, 100);
    expect(result).toBe(95);
    expect(mockCountTokens).toHaveBeenCalledOnce();
  });

  it("calls the API when no fast-check limit is provided", async () => {
    mockCountTokens.mockResolvedValue({ input_tokens: 3 });
    const result = await countTokensInText("hi");
    expect(result).toBe(3);
    expect(mockCountTokens).toHaveBeenCalledOnce();
  });

  it("falls back to the heuristic (chars / 3) when the API throws", async () => {
    mockCountTokens.mockRejectedValue(new Error("network error"));
    const text = "a".repeat(300); // ceil(300 / 3) = 100
    const result = await countTokensInText(text);
    expect(result).toBe(100);
  });

  it("does not throw when the API is unavailable", async () => {
    mockCountTokens.mockRejectedValue(new Error("API key missing"));
    await expect(countTokensInText("some text")).resolves.not.toThrow();
  });
});
