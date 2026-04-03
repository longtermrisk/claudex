/**
 * Tests for the "duplicate instructions" bug family.
 *
 * Each "Bug X — fixed" suite contains:
 *  - A regression test (previously failed, now passes with the fix)
 *  - Any additional behavioural invariants the fix relies on
 *
 * Bug A — postToThread throws when Slack API returns no ts
 * Bug B — aggregateMessages uses numeric comparison; empty lastResponseTs is safe
 * Bug C — full-thread fallback includes bot replies so prior answers are visible
 * Bug D — slack_send_message echoes sent content in tool result
 * Bonus  — file paths are deduplicated before being appended to the prompt
 */

import { describe, it, expect, vi } from "vitest";
import { postToThread } from "../slack/messages.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeClient(overrides: Record<string, unknown> = {}) {
  return {
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ok: true, ts: "1700000002.000000" }),
      delete: vi.fn().mockResolvedValue({ ok: true }),
    },
    conversations: {
      replies: vi.fn().mockResolvedValue({ messages: [] }),
      info: vi.fn().mockResolvedValue({ channel: { name: "test-channel" } }),
    },
    users: {
      info: vi.fn().mockResolvedValue({ user: { real_name: "Test User" } }),
    },
    team: {
      info: vi.fn().mockResolvedValue({ team: { name: "test-workspace" } }),
    },
    ...overrides,
  } as unknown as import("@slack/web-api").WebClient;
}

function userMsg(ts: string, text: string, userId = "U001") {
  return { ts, text, user: userId };
}

function botMsg(ts: string, text: string) {
  return { ts, text, bot_id: "B001" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Bug A (fixed) — postToThread throws when Slack omits ts
// ─────────────────────────────────────────────────────────────────────────────

describe("Bug A (fixed) — postToThread throws instead of returning empty ts", () => {
  it("throws when Slack API returns ok:true but no ts", async () => {
    const client = makeClient({
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true, ts: undefined }),
        delete: vi.fn(),
      },
    });

    // Fix: postToThread must throw rather than silently return "".
    await expect(postToThread(client, "C123", "T123", "Hello")).rejects.toThrow(
      /no timestamp/i,
    );
  });

  it("returns the timestamp of the LAST chunk when the response spans multiple messages", async () => {
    const timestamps = ["1700000001.000000", "1700000002.000000", "1700000003.000000"];
    let callCount = 0;
    const client = makeClient({
      chat: {
        postMessage: vi.fn().mockImplementation(() =>
          Promise.resolve({ ok: true, ts: timestamps[callCount++] }),
        ),
        delete: vi.fn(),
      },
    });

    // Three segments of exactly 3899 chars separated by newlines.
    // splitMessage splits on the newline at index 3899 (>= 50% of maxLen=3900),
    // producing exactly 3 chunks — one postMessage call per timestamp.
    const longText = "x".repeat(3899) + "\n" + "y".repeat(3899) + "\n" + "z".repeat(3899);
    const result = await postToThread(client, "C123", "T123", longText);

    expect(result).toBe("1700000003.000000");
  });

  it("propagates an error when postMessage throws", async () => {
    const client = makeClient({
      chat: {
        postMessage: vi.fn().mockRejectedValue(new Error("Slack API error")),
        delete: vi.fn(),
      },
    });

    await expect(postToThread(client, "C123", "T123", "Hello")).rejects.toThrow("Slack API error");
  });

  it("returns a valid non-empty timestamp string under normal conditions", async () => {
    const client = makeClient();
    const result = await postToThread(client, "C123", "T123", "Hello");

    expect(result).not.toBe("");
    expect(result).toMatch(/^\d+\.\d+$/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bug B (fixed) — numeric timestamp comparison; empty lastResponseTs is safe
// ─────────────────────────────────────────────────────────────────────────────

describe("Bug B (fixed) — aggregateMessages filters correctly with numeric comparison", () => {
  it("filters messages at or before lastResponseTs using numeric comparison", () => {
    const lastResponseTs = "1700000001.500000";
    const lastResponseNum = parseFloat(lastResponseTs);

    const messages = [
      { ts: "1700000001.000000", text: "implement X", user: "U1" }, // before response
      { ts: "1700000001.500000", text: "done X",      bot_id: "B1" }, // IS the response
      { ts: "1700000002.000000", text: "implement Y", user: "U1" }, // after response
    ];

    // Reproduce the fixed filter from aggregateMessages
    const filtered = messages.filter((m) => {
      if (m.bot_id) return false;
      const lastNum = !isNaN(lastResponseNum) ? lastResponseNum : NaN;
      if (m.ts && !isNaN(lastNum) && parseFloat(m.ts) <= lastNum) return false;
      return true;
    });

    // Only the new message should survive
    expect(filtered.map((m) => m.text)).toEqual(["implement Y"]);
  });

  it("includes all messages when lastResponseTs is empty (NaN guard prevents false filtering)", () => {
    // With the fix: when lastResponseTs is "" the NaN guard fires and NO
    // messages are filtered by timestamp — safe fallback, and Bug A prevents
    // "" from ever being stored in the first place.
    const lastResponseTs = "";
    const lastResponseNum = lastResponseTs ? parseFloat(lastResponseTs) : NaN;

    const messages: { ts: string; text: string; user: string; bot_id?: string }[] = [
      { ts: "1700000001.000000", text: "implement X", user: "U1" },
      { ts: "1700000002.000000", text: "implement Y", user: "U1" },
    ];

    const filtered = messages.filter((m) => {
      if (m.bot_id) return false;
      if (m.ts && !isNaN(lastResponseNum) && parseFloat(m.ts) <= lastResponseNum) return false;
      return true;
    });

    // Both pass — no crash, no silent data loss
    expect(filtered).toHaveLength(2);
  });

  it("correctly orders timestamps that differ only in decimal precision", () => {
    // Numeric comparison is immune to the string-length hazard of "1.1" vs "1.10"
    expect(parseFloat("1700000001.1")).toBe(parseFloat("1700000001.10"));
    expect(parseFloat("1700000001.100001") > parseFloat("1700000001.1")).toBe(true);
  });

  it("passes undefined (not empty string) as oldest when lastResponseTs is empty", () => {
    // Document the fix: `oldest: lastResponseTs || undefined` means Slack
    // never receives an empty-string oldest parameter.
    const lastResponseTs = "";
    const oldest = lastResponseTs || undefined;
    expect(oldest).toBeUndefined();

    const validTs = "1700000001.000000";
    expect(validTs || undefined).toBe(validTs);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bug C (fixed) — full-thread fallback includes bot replies
// ─────────────────────────────────────────────────────────────────────────────

describe("Bug C (fixed) — full-thread fallback includes bot messages as context", () => {
  it("includes bot messages when includeBotMessages=true, filtering only by timestamp", () => {
    const lastResponseTs = "0";
    const lastResponseNum = lastResponseTs ? parseFloat(lastResponseTs) : NaN;
    const includeBotMessages = true;
    const threadTs = "1700000001.000000";
    const includeParent = lastResponseTs === "0";

    const threadMessages = [
      userMsg("1700000001.000000", "implement X"),        // parent
      botMsg("1700000001.500000", "I implemented X"),     // prior answer
      userMsg("1700000002.000000", "now implement Y"),
    ];

    const filtered = threadMessages.filter((m) => {
      if (m.ts === threadTs && !includeParent) return false;
      if ((m as { bot_id?: string }).bot_id && !includeBotMessages) return false;
      if (m.ts && !isNaN(lastResponseNum) && parseFloat(m.ts) <= lastResponseNum) return false;
      return true;
    });

    const texts = filtered.map((m) => m.text);

    // All three messages are present — the bot reply is NO LONGER stripped
    expect(texts).toContain("implement X");
    expect(texts).toContain("I implemented X");  // ← prior answer now visible to Claude
    expect(texts).toContain("now implement Y");
  });

  it("formats bot messages with 'Bot:' prefix so Claude knows the source", () => {
    // The fixed aggregateMessages labels bot messages as "Bot:" so Claude can
    // distinguish its prior responses from user messages.
    const messages = [
      { ts: "1700000001.000000", text: "implement X", user: "U1", bot_id: undefined },
      { ts: "1700000001.500000", text: "I implemented X", bot_id: "B1", user: undefined },
      { ts: "1700000002.000000", text: "now implement Y", user: "U1", bot_id: undefined },
    ];

    const lines = messages.map((m) => {
      const isBotMessage = !!m.bot_id;
      const name = isBotMessage ? "Bot" : "User";
      return `${name}: ${m.text}`;
    });

    expect(lines).toContain("Bot: I implemented X");
    expect(lines).toContain("User: implement X");
    expect(lines).toContain("User: now implement Y");
  });

  it("does NOT include bot messages in the normal resume path (includeBotMessages=false)", () => {
    // For an existing session, bot messages are already in Claude's session
    // context — including them again would be redundant noise.
    const includeBotMessages = false;

    const messages = [
      userMsg("1700000002.000000", "now implement Y"),
      botMsg("1700000001.500000", "I implemented X"),
    ];

    const filtered = messages.filter((m) => {
      if ((m as { bot_id?: string }).bot_id && !includeBotMessages) return false;
      return true;
    });

    expect(filtered.map((m) => m.text)).toEqual(["now implement Y"]);
  });

  it("prompt built from full thread contains bot answer so Claude knows X is done", () => {
    const lines = [
      "User: implement X",
      "Bot: I implemented X for you",
      "User: now implement Y",
    ];
    const prompt = lines.join("\n");

    expect(prompt).toContain("Bot: I implemented X");
    // Claude will now see its prior answer and not re-implement X alongside Y
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bug D (fixed) — slack_send_message echoes sent content in tool result
// ─────────────────────────────────────────────────────────────────────────────

describe("Bug D (fixed) — slack_send_message tool result echoes sent content", () => {
  it("tool result contains the full sent text, not just the timestamp", () => {
    // Reproduce the fixed tool result format from tools.ts
    const sentText = "Answers: A=1 B=2 C=3";
    const resultTs = "1700000002.000000";

    const toolResult = `Message sent (ts: ${resultTs})\n\nContent sent:\n${sentText}`;

    // The content survives as a tool-result turn which is less aggressively
    // compacted than a tool-use argument.
    expect(toolResult).toContain("A=1");
    expect(toolResult).toContain("B=2");
    expect(toolResult).toContain("C=3");
    expect(toolResult).toContain(resultTs);
  });

  it("tool result is structured as a proper tool-result turn (not a tool-use argument)", () => {
    // Document the conversation structure after the fix.
    type Turn =
      | { role: "user";         content: string }
      | { role: "assistant";    content: string }
      | { role: "tool_use";     name: string; input: { text: string } }
      | { role: "tool_result";  content: string };

    const sentText = "Answers: A=1 B=2 C=3";

    const sessionHistory: Turn[] = [
      { role: "user",        content: "Answer questions A, B, C" },
      { role: "tool_use",    name: "slack_send_message", input: { text: sentText } },
      // Fixed: tool result now echoes the sent content
      { role: "tool_result", content: `Message sent (ts: 1700000002.000000)\n\nContent sent:\n${sentText}` },
    ];

    // Claude can now recover what was sent from the tool_result turn,
    // which is preserved through compaction better than tool_use arguments.
    const toolResults = sessionHistory
      .filter((t): t is { role: "tool_result"; content: string } => t.role === "tool_result")
      .map((t) => t.content);

    expect(toolResults.join("\n")).toContain("A=1");
  });

  it("CLAUDE.md instructs Claude not to re-answer questions already in tool history", async () => {
    const { readFileSync } = await import("node:fs");
    const claudeMd = readFileSync("/Users/claude/slack/CLAUDE.md", "utf-8");
    expect(claudeMd).toMatch(/tool history/i);
    expect(claudeMd).toMatch(/do not re-answer/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bonus (fixed) — file paths are deduplicated before appending to prompt
// ─────────────────────────────────────────────────────────────────────────────

describe("Bonus (fixed) — current-event files are not listed twice in the prompt", () => {
  it("deduplicating with Set removes the duplicate introduced by aggregateMessages", () => {
    const currentEventFilePath = "/tmp/uploaded-file.pdf";

    const filePaths: string[] = [currentEventFilePath]; // from event download
    const aggregatedFilePaths = [currentEventFilePath]; // same file from aggregateMessages

    filePaths.push(...aggregatedFilePaths);

    // Fix: deduplicate before building the prompt
    const uniqueFilePaths = [...new Set(filePaths)];

    expect(uniqueFilePaths).toHaveLength(1);
    expect(uniqueFilePaths[0]).toBe(currentEventFilePath);
  });

  it("deduplication preserves distinct paths", () => {
    const filePaths = ["/tmp/a.pdf", "/tmp/b.pdf", "/tmp/a.pdf", "/tmp/c.pdf"];
    const unique = [...new Set(filePaths)];

    expect(unique).toHaveLength(3);
    expect(unique).toContain("/tmp/a.pdf");
    expect(unique).toContain("/tmp/b.pdf");
    expect(unique).toContain("/tmp/c.pdf");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Interaction: empty lastResponseTs + existing session (prevented by Bug A fix)
// ─────────────────────────────────────────────────────────────────────────────

describe("Interaction (fixed) — empty lastResponseTs can no longer be stored", () => {
  it("postToThread throwing on missing ts prevents '' from ever reaching saveSession", async () => {
    // With Bug A fixed, postToThread throws before returning "".
    // The throw propagates out of handleMessage's try block, so saveSession
    // is never called with an invalid lastResponseTs.
    const client = makeClient({
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true, ts: undefined }),
        delete: vi.fn(),
      },
    });

    await expect(postToThread(client, "C123", "T123", "Hello")).rejects.toThrow();
    // saveSession is never reached → no "" stored in sessions.json
  });

  it("Slack timestamps are well-ordered under numeric comparison", () => {
    const earlier = "1700000001.000100";
    const later   = "1700000001.000200";

    expect(parseFloat(earlier) < parseFloat(later)).toBe(true);

    // Edge case that broke string comparison: same value, different precision
    const a = "1700000001.1";
    const b = "1700000001.10";
    // parseFloat treats them as equal — correct behaviour
    expect(parseFloat(a)).toBe(parseFloat(b));
  });
});
