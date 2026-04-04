import { describe, it, expect } from "vitest";
import { consumeResponse } from "./response.js";
import type { Query } from "@anthropic-ai/claude-agent-sdk";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal success result message */
function makeSuccessResult(overrides: Record<string, unknown> = {}): object {
  return {
    type: "result",
    subtype: "success",
    session_id: "sess-abc",
    result: "All done!",
    total_cost_usd: 0.02,
    duration_ms: 500,
    duration_api_ms: 400,
    is_error: false,
    num_turns: 2,
    stop_reason: "end_turn",
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    modelUsage: {
      "claude-opus-4-5-20251101": {
        inputTokens: 120_000,
        outputTokens: 500,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUSD: 0.02,
        contextWindow: 200_000,
        maxOutputTokens: 4096,
      },
    },
    permission_denials: [],
    errors: [],
    uuid: "uuid-result",
    ...overrides,
  };
}

/** Wrap an array of plain objects into a Query-compatible async iterable */
function makeQuery(messages: object[]): Query {
  return (async function* () {
    for (const msg of messages) yield msg;
  })() as unknown as Query;
}

/** A timeout getter that never fires during tests */
const noTimeout = () => 60_000;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("consumeResponse — session ID", () => {
  it("captures session_id from the init message", async () => {
    const gen = makeQuery([
      { type: "system", subtype: "init", session_id: "sess-init-123", uuid: "u1" },
      makeSuccessResult({ session_id: "sess-result-456" }),
    ]);
    const result = await consumeResponse(gen, noTimeout);
    expect(result.sessionId).toBe("sess-result-456"); // result wins over init
  });

  it("falls back to init session_id when result has none", async () => {
    const gen = makeQuery([
      { type: "system", subtype: "init", session_id: "sess-init-789", uuid: "u1" },
      makeSuccessResult({ session_id: "" }),
    ]);
    const result = await consumeResponse(gen, noTimeout);
    expect(result.sessionId).toBe("sess-init-789");
  });
});

describe("consumeResponse — auto-compaction detection", () => {
  it("sets didAutoCompact=false when no compact_boundary is seen", async () => {
    const gen = makeQuery([makeSuccessResult()]);
    const result = await consumeResponse(gen, noTimeout);
    expect(result.didAutoCompact).toBe(false);
  });

  it("sets didAutoCompact=true when a compact_boundary message is seen", async () => {
    const gen = makeQuery([
      {
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "auto", pre_tokens: 38_000 },
        uuid: "u-compact",
        session_id: "sess-abc",
      },
      makeSuccessResult(),
    ]);
    const result = await consumeResponse(gen, noTimeout);
    expect(result.didAutoCompact).toBe(true);
  });

  it("captures pre_tokens from the compact_boundary message", async () => {
    const gen = makeQuery([
      {
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "auto", pre_tokens: 42_500 },
        uuid: "u-compact",
        session_id: "sess-abc",
      },
      makeSuccessResult(),
    ]);
    const result = await consumeResponse(gen, noTimeout);
    expect(result.compactionPreTokens).toBe(42_500);
  });

  it("records the pre_tokens from the last compaction when multiple fire", async () => {
    const gen = makeQuery([
      {
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "auto", pre_tokens: 30_000 },
        uuid: "u1",
        session_id: "sess-abc",
      },
      {
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "auto", pre_tokens: 35_000 },
        uuid: "u2",
        session_id: "sess-abc",
      },
      makeSuccessResult(),
    ]);
    const result = await consumeResponse(gen, noTimeout);
    expect(result.compactionPreTokens).toBe(35_000);
  });
});

describe("consumeResponse — context window stats", () => {
  it("extracts contextTokens and contextWindowSize from modelUsage", async () => {
    const gen = makeQuery([makeSuccessResult()]);
    const result = await consumeResponse(gen, noTimeout);
    expect(result.contextTokens).toBe(120_000);
    expect(result.contextWindowSize).toBe(200_000);
  });

  it("picks the model with the highest inputTokens when multiple models are present", async () => {
    const gen = makeQuery([
      makeSuccessResult({
        modelUsage: {
          "claude-haiku": {
            inputTokens: 1_000,
            outputTokens: 100,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 0.001,
            contextWindow: 200_000,
            maxOutputTokens: 4096,
          },
          "claude-opus": {
            inputTokens: 150_000,
            outputTokens: 500,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 0.02,
            contextWindow: 200_000,
            maxOutputTokens: 4096,
          },
        },
      }),
    ]);
    const result = await consumeResponse(gen, noTimeout);
    expect(result.contextTokens).toBe(150_000); // highest inputTokens
  });

  it("leaves contextTokens undefined when modelUsage is absent", async () => {
    const gen = makeQuery([makeSuccessResult({ modelUsage: undefined })]);
    const result = await consumeResponse(gen, noTimeout);
    expect(result.contextTokens).toBeUndefined();
    expect(result.contextWindowSize).toBeUndefined();
  });
});

describe("consumeResponse — result handling", () => {
  it("returns isError=false and the result text on success", async () => {
    const gen = makeQuery([makeSuccessResult({ result: "Hello world" })]);
    const result = await consumeResponse(gen, noTimeout);
    expect(result.isError).toBe(false);
    expect(result.text).toBe("Hello world");
    expect(result.costUsd).toBe(0.02);
  });

  it("returns isError=true on error_max_turns", async () => {
    const errorResult = {
      type: "result",
      subtype: "error_max_turns",
      session_id: "sess-err",
      result: "",
      total_cost_usd: 0.005,
      duration_ms: 100,
      duration_api_ms: 80,
      is_error: true,
      num_turns: 500,
      stop_reason: null,
      usage: { input_tokens: 50, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      modelUsage: {},
      permission_denials: [],
      errors: ["Turn limit exceeded"],
      uuid: "uuid-err",
    };
    const gen = makeQuery([errorResult]);
    const result = await consumeResponse(gen, noTimeout);
    expect(result.isError).toBe(true);
    expect(result.subtype).toBe("error_max_turns");
    expect(result.text).toContain("Turn limit exceeded");
  });

  it("handles an empty generator gracefully", async () => {
    const gen = makeQuery([]);
    const result = await consumeResponse(gen, noTimeout);
    expect(result.isError).toBe(true);
    expect(result.text).toContain("No response received");
    expect(result.costUsd).toBe(0);
  });

  it("uses a fallback text when result is empty string", async () => {
    const gen = makeQuery([makeSuccessResult({ result: "" })]);
    const result = await consumeResponse(gen, noTimeout);
    expect(result.text).toBe("Done (no text output).");
  });
});
