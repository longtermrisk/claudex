/**
 * Crash-prevention tests for consumeResponse.
 *
 * These test what happens when the Claude Code subprocess crashes mid-stream,
 * which typically surfaces as: "Claude Code process exited with code 1".
 *
 * The SDK query() returns an async generator. If the subprocess crashes, the
 * generator throws. consumeResponse must handle this gracefully.
 */
import { describe, it, expect } from "vitest";
import { consumeResponse } from "../../src/claude/response.js";

/* ------------------------------------------------------------------ */
/*  Helper: generators that simulate SDK failures                     */
/* ------------------------------------------------------------------ */

/** Generator that yields some messages then throws (subprocess crash mid-stream) */
async function* crashMidStream(error: Error): AsyncGenerator<any> {
  yield { type: "system", subtype: "init", session_id: "sess-123" };
  yield { type: "assistant", text: "Working on it..." };
  throw error;
}

/** Generator that throws immediately (subprocess fails to start) */
async function* crashImmediately(error: Error): AsyncGenerator<any> {
  throw error;
}

/** Generator that yields init, then crashes */
async function* crashAfterInit(error: Error): AsyncGenerator<any> {
  yield { type: "system", subtype: "init", session_id: "sess-456" };
  throw error;
}

/** Generator that yields a result with missing/undefined fields */
async function* resultWithMissingFields(): AsyncGenerator<any> {
  yield { type: "system", subtype: "init", session_id: "s1" };
  yield {
    type: "result",
    subtype: "success",
    // result field is missing (undefined)
    session_id: "s1",
    // total_cost_usd is missing (undefined)
  };
}

/** Generator that yields a result where total_cost_usd is NaN */
async function* resultWithNaNCost(): AsyncGenerator<any> {
  yield { type: "system", subtype: "init", session_id: "s1" };
  yield {
    type: "result",
    subtype: "success",
    result: "Done",
    session_id: "s1",
    total_cost_usd: undefined,
  };
}

/** Custom iterable that hangs on return() — simulates stuck subprocess cleanup */
function iterableWithHangingReturn(): AsyncIterable<any> {
  let nextCalled = false;
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (!nextCalled) {
            nextCalled = true;
            return {
              value: { type: "system", subtype: "init", session_id: "s1" },
              done: false,
            };
          }
          // Second next() hangs
          return new Promise<IteratorResult<any>>(() => {});
        },
        // return() also hangs — simulates subprocess that won't die
        return: () => new Promise<IteratorResult<any>>(() => {}),
      };
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Tests: generator throws during iteration                          */
/* ------------------------------------------------------------------ */
describe("consumeResponse – generator crash mid-stream", () => {
  it("propagates error when generator throws mid-stream (process exit)", async () => {
    const error = new Error("Claude Code process exited with code 1");
    const stream = crashMidStream(error);

    // consumeResponse does NOT catch generator errors — they propagate.
    // This is the primary path for "process exited with code 1" errors.
    await expect(consumeResponse(stream as any)).rejects.toThrow(
      "Claude Code process exited with code 1",
    );
  });

  it("propagates error when generator throws immediately", async () => {
    const error = new Error("Claude Code process exited with code 1");
    const stream = crashImmediately(error);

    await expect(consumeResponse(stream as any)).rejects.toThrow(
      "Claude Code process exited with code 1",
    );
  });

  it("propagates error even when session_id was already captured", async () => {
    const error = new Error("subprocess terminated unexpectedly");
    const stream = crashAfterInit(error);

    // Even though we got a session_id, the error still propagates
    // (the session_id is lost because consumeResponse doesn't catch)
    await expect(consumeResponse(stream as any)).rejects.toThrow(
      "subprocess terminated unexpectedly",
    );
  });

  it("handles non-Error throws from generator", async () => {
    async function* throwString(): AsyncGenerator<any> {
      throw "raw string error";
    }

    await expect(consumeResponse(throwString() as any)).rejects.toBe(
      "raw string error",
    );
  });
});

/* ------------------------------------------------------------------ */
/*  Tests: result message with missing/unusual fields                 */
/* ------------------------------------------------------------------ */
describe("consumeResponse – malformed result messages", () => {
  it("handles result with undefined result field", async () => {
    const stream = resultWithMissingFields();
    const res = await consumeResponse(stream as any);
    // result is undefined, but subtype is "success", so the code does:
    // result.result || "Done (no text output)."
    // undefined || "Done (no text output)." → "Done (no text output)."
    expect(res.isError).toBe(false);
    expect(res.text).toBe("Done (no text output).");
  });

  it("handles result with undefined total_cost_usd", async () => {
    const stream = resultWithNaNCost();
    const res = await consumeResponse(stream as any);
    // total_cost_usd is undefined → costUsd is undefined
    expect(res.isError).toBe(false);
    expect(res.costUsd).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/*  Tests: inactivity timeout with stuck cleanup                      */
/* ------------------------------------------------------------------ */
describe("consumeResponse – timeout cleanup risks", () => {
  it("hangs when iterator.return() never resolves after timeout", async () => {
    // This test documents a real risk: if the Claude Code subprocess is
    // truly stuck and iterator.return() hangs, consumeResponse hangs forever.
    // The activeThreads entry is never cleaned up, permanently blocking
    // that thread from being processed again.
    //
    // We verify this by racing the consumeResponse call against a short timer.
    const stream = iterableWithHangingReturn();
    const result = await Promise.race([
      consumeResponse(stream as any, () => 50).then(() => "resolved"),
      new Promise<string>((r) => setTimeout(() => r("timed-out"), 2000)),
    ]);

    // If consumeResponse hangs on iterator.return(), we'll get "timed-out"
    // If it completes (no hang), we'll get "resolved"
    // Current behavior: hangs because return() never resolves in the finally block
    expect(result).toBe("timed-out");
  });
});
