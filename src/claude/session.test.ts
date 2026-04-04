/**
 * Session tests.
 *
 * Verifies the contract between our session helpers and the Claude Agent SDK:
 *
 *  1. Our code passes the correct options to query() — in particular,
 *     settingSources always includes "project", which tells the SDK to load
 *     CLAUDE.md from the working directory.
 *
 *  2. Our code NEVER manually injects CLAUDE.md content into the prompt string.
 *     CLAUDE.md loading is fully delegated to the SDK via settingSources.
 *
 *  3. Resume calls pass a clean single-turn prompt, not an ever-growing string
 *     that concatenates previous history.
 *
 * ⚠️  Limitation — what these tests do NOT cover:
 *     Whether the SDK itself injects CLAUDE.md once (into the system prompt) or
 *     at every turn (into the messages array, causing N duplicates after N turns).
 *     The SDK ships as a minified bundle (sdk.mjs) so its internal behaviour
 *     cannot be verified from source inspection alone.  An integration test
 *     intercepting raw HTTP calls to the Anthropic Messages API would be needed
 *     to fully close that question.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";
import type { Query } from "@anthropic-ai/claude-agent-sdk";

// ---------------------------------------------------------------------------
// Hoist the SDK mock so it intercepts the module-level import in session.ts
// ---------------------------------------------------------------------------

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

// Import AFTER mock registration
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createSession, resumeSession, summarizeSession } from "./session.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal async iterable that yields one success result — enough for consumeResponse */
function makeMinimalQuery(): Query {
  return (async function* () {
    yield {
      type: "result",
      subtype: "success",
      session_id: "test-sess",
      result: "ok",
      total_cost_usd: 0,
      duration_ms: 1,
      duration_api_ms: 1,
      is_error: false,
      num_turns: 1,
      stop_reason: "end_turn",
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      modelUsage: {},
      permission_denials: [],
      errors: [],
      uuid: "u1",
    };
  })() as unknown as Query;
}

/** Extract the params from the Nth call to query() (0-indexed) */
function callParams(n = 0): { prompt: string; options: Record<string, unknown> } {
  const calls = vi.mocked(query).mock.calls;
  expect(calls.length, `expected at least ${n + 1} query() call(s)`).toBeGreaterThan(n);
  return calls[n][0] as { prompt: string; options: Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// Reset between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(query).mockImplementation(() => makeMinimalQuery());
});

// ---------------------------------------------------------------------------
// createSession
// ---------------------------------------------------------------------------

describe("createSession", () => {
  it("calls query() exactly once", async () => {
    await createSession("Hello", "/workspace");
    expect(vi.mocked(query).mock.calls).toHaveLength(1);
  });

  it("passes the user prompt verbatim — no CLAUDE.md injection by our code", async () => {
    await createSession("Do the thing", "/workspace");
    expect(callParams().prompt).toBe("Do the thing");
  });

  it("does not prepend CLAUDE.md content to the prompt", async () => {
    await createSession("User message", "/workspace");
    const { prompt } = callParams();
    expect(prompt).not.toContain("CLAUDE.md");
    expect(prompt).not.toMatch(/^#\s/); // no markdown heading injected at the start
  });

  it("includes settingSources ['user', 'project'] — required for the SDK to load CLAUDE.md", async () => {
    await createSession("Hello", "/workspace");
    expect(callParams().options.settingSources).toEqual(
      expect.arrayContaining(["user", "project"]),
    );
  });

  it("does NOT set resume (fresh session)", async () => {
    await createSession("Hello", "/workspace");
    expect(callParams().options.resume).toBeUndefined();
  });

  it("passes cwd correctly", async () => {
    await createSession("Hello", "/my/project");
    expect(callParams().options.cwd).toBe("/my/project");
  });

  it("uses bypassPermissions mode", async () => {
    await createSession("Hello", "/workspace");
    expect(callParams().options.permissionMode).toBe("bypassPermissions");
  });
});

// ---------------------------------------------------------------------------
// resumeSession
// ---------------------------------------------------------------------------

describe("resumeSession", () => {
  it("calls query() exactly once", async () => {
    await resumeSession("Follow-up", "/workspace", "sess-123");
    expect(vi.mocked(query).mock.calls).toHaveLength(1);
  });

  it("passes the user prompt verbatim — no CLAUDE.md re-injection on resume", async () => {
    await resumeSession("Turn N message", "/workspace", "sess-123");
    expect(callParams().prompt).toBe("Turn N message");
  });

  it("passes the session ID as the resume option", async () => {
    await resumeSession("Continue", "/workspace", "sess-abc");
    expect(callParams().options.resume).toBe("sess-abc");
  });

  it("includes settingSources ['user', 'project'] on every resume call", async () => {
    await resumeSession("Turn 2", "/workspace", "sess-abc");
    expect(callParams().options.settingSources).toEqual(
      expect.arrayContaining(["user", "project"]),
    );
  });

  it("prompt stays constant across multiple resumes — history is NOT manually accumulated", async () => {
    // If our code were building up conversation history by concatenating
    // previous prompts, the prompt string would grow with each turn.
    // Each call must receive only the current turn's message.
    await resumeSession("Turn 2", "/workspace", "sess-abc");
    await resumeSession("Turn 3", "/workspace", "sess-abc");
    await resumeSession("Turn 4", "/workspace", "sess-abc");

    expect(callParams(0).prompt).toBe("Turn 2");
    expect(callParams(1).prompt).toBe("Turn 3");
    expect(callParams(2).prompt).toBe("Turn 4");
  });

  it("prompt length does not grow with the number of resumes", async () => {
    // Simulate 10 rounds of conversation — the classic scenario from the bug report.
    // If prompts were accumulating, by round 10 the prompt would be ~10x larger.
    const turns = Array.from({ length: 10 }, (_, i) => `Round ${i + 1}`);

    for (const turn of turns) {
      await resumeSession(turn, "/workspace", "sess-abc");
    }

    turns.forEach((turn, i) => {
      expect(callParams(i).prompt).toBe(turn);
      expect((callParams(i).prompt as string).length).toBe(turn.length);
    });
  });
});

// ---------------------------------------------------------------------------
// summarizeSession
// ---------------------------------------------------------------------------

describe("summarizeSession", () => {
  it("calls query() exactly once", async () => {
    await summarizeSession("/workspace", "sess-timeout");
    expect(vi.mocked(query).mock.calls).toHaveLength(1);
  });

  it("uses the built-in summary prompt (not a user-provided string)", async () => {
    await summarizeSession("/workspace", "sess-timeout");
    expect(callParams().prompt).toContain("maximum turn limit");
  });

  it("passes the session ID as the resume option", async () => {
    await summarizeSession("/workspace", "sess-xyz");
    expect(callParams().options.resume).toBe("sess-xyz");
  });

  it("uses a small maxTurns budget (≤ 10) to prevent runaway summarisation", async () => {
    await summarizeSession("/workspace", "sess-xyz");
    expect(callParams().options.maxTurns as number).toBeLessThanOrEqual(10);
  });

  it("includes settingSources ['user', 'project']", async () => {
    await summarizeSession("/workspace", "sess-xyz");
    expect(callParams().options.settingSources).toEqual(
      expect.arrayContaining(["user", "project"]),
    );
  });
});
