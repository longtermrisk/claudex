import { describe, it, expect, vi } from "vitest";
import { consumeResponse, DEFAULT_INACTIVITY_TIMEOUT_MS } from "../../src/claude/response.js";

/* ------------------------------------------------------------------ */
/*  Helpers: fake async generators that mimic Claude SDK streams      */
/* ------------------------------------------------------------------ */
async function* fakeStream(messages: any[]): AsyncGenerator<any> {
  for (const msg of messages) {
    yield msg;
  }
}

async function* slowStream(
  messages: any[],
  delayMs: number,
): AsyncGenerator<any> {
  for (const msg of messages) {
    await new Promise((r) => setTimeout(r, delayMs));
    yield msg;
  }
}

/**
 * Custom async iterable whose next() never resolves but whose return()
 * resolves immediately — avoids withInactivityTimeout hanging on cleanup.
 */
function hangingIterable(): AsyncIterable<any> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise<IteratorResult<any>>(() => {}), // never resolves
        return: async () => ({ value: undefined, done: true as const }),
      };
    },
  };
}

/* ------------------------------------------------------------------ */
/*  DEFAULT_INACTIVITY_TIMEOUT_MS                                     */
/* ------------------------------------------------------------------ */
describe("DEFAULT_INACTIVITY_TIMEOUT_MS", () => {
  it("defaults to 10 minutes when env var is not set", () => {
    // env var is not set in tests, so default applies
    expect(DEFAULT_INACTIVITY_TIMEOUT_MS).toBe(10 * 60 * 1000);
  });
});

/* ------------------------------------------------------------------ */
/*  consumeResponse                                                   */
/* ------------------------------------------------------------------ */
describe("consumeResponse", () => {
  it("captures session_id from init message", async () => {
    const stream = fakeStream([
      { type: "system", subtype: "init", session_id: "sess-abc" },
      {
        type: "result",
        subtype: "success",
        result: "Done",
        session_id: "sess-abc",
        total_cost_usd: 0.01,
      },
    ]);
    const res = await consumeResponse(stream as any);
    expect(res.sessionId).toBe("sess-abc");
  });

  it("returns the result text on success", async () => {
    const stream = fakeStream([
      { type: "system", subtype: "init", session_id: "s1" },
      {
        type: "result",
        subtype: "success",
        result: "All done!",
        session_id: "s1",
        total_cost_usd: 0.05,
      },
    ]);
    const res = await consumeResponse(stream as any);
    expect(res.text).toBe("All done!");
    expect(res.isError).toBe(false);
    expect(res.costUsd).toBe(0.05);
  });

  it('returns "Done (no text output)." when result is empty', async () => {
    const stream = fakeStream([
      { type: "system", subtype: "init", session_id: "s1" },
      {
        type: "result",
        subtype: "success",
        result: "",
        session_id: "s1",
        total_cost_usd: 0,
      },
    ]);
    const res = await consumeResponse(stream as any);
    expect(res.text).toBe("Done (no text output).");
    expect(res.isError).toBe(false);
  });

  it("detects token-based auto-compaction", async () => {
    const stream = fakeStream([
      { type: "system", subtype: "init", session_id: "s1" },
      { type: "system", subtype: "compact_boundary" },
      {
        type: "result",
        subtype: "success",
        result: "Done",
        session_id: "s1",
        total_cost_usd: 0,
      },
    ]);
    const res = await consumeResponse(stream as any);
    expect(res.didAutoCompact).toBe(true);
  });

  it("didAutoCompact is falsy when no compaction occurs", async () => {
    const stream = fakeStream([
      { type: "system", subtype: "init", session_id: "s1" },
      {
        type: "result",
        subtype: "success",
        result: "Done",
        session_id: "s1",
        total_cost_usd: 0,
      },
    ]);
    const res = await consumeResponse(stream as any);
    expect(res.didAutoCompact).toBeFalsy();
  });

  it("returns error result with errors array", async () => {
    const stream = fakeStream([
      { type: "system", subtype: "init", session_id: "s1" },
      {
        type: "result",
        subtype: "error_max_turns",
        errors: ["Turn limit exceeded"],
        session_id: "s1",
        total_cost_usd: 0.1,
      },
    ]);
    const res = await consumeResponse(stream as any);
    expect(res.isError).toBe(true);
    expect(res.subtype).toBe("error_max_turns");
    expect(res.text).toBe("Error: Turn limit exceeded");
    expect(res.costUsd).toBe(0.1);
  });

  it("returns error subtype as text when no errors array", async () => {
    const stream = fakeStream([
      { type: "system", subtype: "init", session_id: "s1" },
      {
        type: "result",
        subtype: "error_unknown",
        session_id: "s1",
        total_cost_usd: 0,
      },
    ]);
    const res = await consumeResponse(stream as any);
    expect(res.isError).toBe(true);
    expect(res.text).toBe("Error: error_unknown");
  });

  it("returns error when stream yields no result message", async () => {
    const stream = fakeStream([
      { type: "system", subtype: "init", session_id: "s1" },
      // No result message
    ]);
    const res = await consumeResponse(stream as any);
    expect(res.isError).toBe(true);
    expect(res.text).toBe("No response received from Claude.");
    expect(res.sessionId).toBe("s1");
  });

  it("returns error with empty sessionId when stream is completely empty", async () => {
    const stream = fakeStream([]);
    const res = await consumeResponse(stream as any);
    expect(res.isError).toBe(true);
    expect(res.sessionId).toBe("");
  });

  it("prefers session_id from result message over init", async () => {
    const stream = fakeStream([
      { type: "system", subtype: "init", session_id: "init-id" },
      {
        type: "result",
        subtype: "success",
        result: "Done",
        session_id: "result-id",
        total_cost_usd: 0,
      },
    ]);
    const res = await consumeResponse(stream as any);
    expect(res.sessionId).toBe("result-id");
  });

  it("keeps init session_id when result has no session_id", async () => {
    const stream = fakeStream([
      { type: "system", subtype: "init", session_id: "init-id" },
      {
        type: "result",
        subtype: "success",
        result: "Done",
        session_id: "",
        total_cost_usd: 0,
      },
    ]);
    const res = await consumeResponse(stream as any);
    expect(res.sessionId).toBe("init-id");
  });

  it("ignores intermediate non-system/result messages", async () => {
    const stream = fakeStream([
      { type: "system", subtype: "init", session_id: "s1" },
      { type: "assistant", text: "thinking..." },
      { type: "tool_use", tool: "bash" },
      { type: "tool_result", result: "ok" },
      {
        type: "result",
        subtype: "success",
        result: "Final",
        session_id: "s1",
        total_cost_usd: 0,
      },
    ]);
    const res = await consumeResponse(stream as any);
    expect(res.text).toBe("Final");
    expect(res.isError).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  Inactivity timeout                                                */
/* ------------------------------------------------------------------ */
describe("consumeResponse – inactivity timeout", () => {
  it("aborts when stream is inactive beyond the timeout", async () => {
    // An iterable that hangs forever on next() but cleans up on return()
    const stream = hangingIterable();
    const res = await consumeResponse(stream as any, () => 50);
    // Should get "No response received" because no result was yielded
    expect(res.isError).toBe(true);
    expect(res.text).toBe("No response received from Claude.");
  });

  it("succeeds when stream yields before timeout", async () => {
    const stream = slowStream(
      [
        { type: "system", subtype: "init", session_id: "s1" },
        {
          type: "result",
          subtype: "success",
          result: "OK",
          session_id: "s1",
          total_cost_usd: 0,
        },
      ],
      10, // 10ms delay per message — well under any reasonable timeout
    );
    const res = await consumeResponse(stream as any, () => 5000);
    expect(res.isError).toBe(false);
    expect(res.text).toBe("OK");
  });

  it("re-evaluates timeout on every iteration (dynamic timeout)", async () => {
    // getTimeoutMs is called on every iteration; use a counter to prove it
    let callCount = 0;
    const getTimeout = () => {
      callCount++;
      // Short first time (but generator yields immediately), long second time
      return callCount === 1 ? 50 : 5000;
    };

    const stream = (async function* () {
      yield { type: "system", subtype: "init", session_id: "s1" };
      await new Promise((r) => setTimeout(r, 100)); // 100ms < 5000ms second timeout
      yield {
        type: "result",
        subtype: "success",
        result: "OK",
        session_id: "s1",
        total_cost_usd: 0,
      };
    })();

    const res = await consumeResponse(stream as any, getTimeout);
    expect(callCount).toBeGreaterThan(1); // Proves getTimeoutMs was re-evaluated
    expect(res.isError).toBe(false);
    expect(res.text).toBe("OK");
  });
});
