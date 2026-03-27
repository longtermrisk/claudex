import { describe, it, expect, vi, beforeEach } from "vitest";
import { formatForSlack, postToThread } from "../../src/slack/messages.js";

/* ------------------------------------------------------------------ */
/*  formatForSlack – pure string transformation                       */
/* ------------------------------------------------------------------ */
describe("formatForSlack", () => {
  it("converts markdown bold **text** to slack bold *text*", () => {
    expect(formatForSlack("**hello world**")).toBe("*hello world*");
  });

  it("converts multiple bold segments", () => {
    expect(formatForSlack("**a** and **b**")).toBe("*a* and *b*");
  });

  it("converts h1 headings to bold", () => {
    expect(formatForSlack("# Heading")).toBe("*Heading*");
  });

  it("converts h2-h6 headings to bold", () => {
    expect(formatForSlack("## Sub")).toBe("*Sub*");
    expect(formatForSlack("### Deep")).toBe("*Deep*");
    expect(formatForSlack("###### Deepest")).toBe("*Deepest*");
  });

  it("only converts headings at the start of a line", () => {
    expect(formatForSlack("not a # heading")).toBe("not a # heading");
  });

  it("converts multiline headings independently", () => {
    expect(formatForSlack("# First\n## Second\nPlain")).toBe(
      "*First*\n*Second*\nPlain",
    );
  });

  it("converts markdown links [text](url) to <url|text>", () => {
    expect(formatForSlack("[click here](https://example.com)")).toBe(
      "<https://example.com|click here>",
    );
  });

  it("handles multiple links in one line", () => {
    expect(formatForSlack("[a](http://a.com) and [b](http://b.com)")).toBe(
      "<http://a.com|a> and <http://b.com|b>",
    );
  });

  it("preserves code blocks", () => {
    const input = "```\nconst x = 1;\n```";
    expect(formatForSlack(input)).toBe(input);
  });

  it("handles combined bold, headings, and links", () => {
    const input = "# Title\n\n**bold** and [link](http://x.com)";
    expect(formatForSlack(input)).toBe(
      "*Title*\n\n*bold* and <http://x.com|link>",
    );
  });

  it("returns empty string for empty input", () => {
    expect(formatForSlack("")).toBe("");
  });

  it("passes through plain text unchanged", () => {
    expect(formatForSlack("hello world")).toBe("hello world");
  });

  it("does not convert single asterisks (already slack bold)", () => {
    // Single *text* should stay as-is (it's already valid mrkdwn bold)
    expect(formatForSlack("*already bold*")).toBe("*already bold*");
  });
});

/* ------------------------------------------------------------------ */
/*  postToThread – posting + splitting behaviour                      */
/* ------------------------------------------------------------------ */
describe("postToThread", () => {
  let mockClient: any;
  let postCount: number;

  beforeEach(() => {
    postCount = 0;
    mockClient = {
      chat: {
        postMessage: vi.fn(async () => ({ ts: `ts-${++postCount}` })),
      },
    };
  });

  it("posts a single message for short text", async () => {
    const ts = await postToThread(mockClient, "C123", "1234.5678", "hello");
    expect(mockClient.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(mockClient.chat.postMessage).toHaveBeenCalledWith({
      channel: "C123",
      thread_ts: "1234.5678",
      text: "hello",
    });
    expect(ts).toBe("ts-1");
  });

  it("returns the timestamp of the last message posted", async () => {
    // 8000 chars → ~3 chunks (3900 + 3900 + 200)
    const ts = await postToThread(
      mockClient,
      "C123",
      "1234.5678",
      "a".repeat(8000),
    );
    expect(ts).toBe(`ts-${mockClient.chat.postMessage.mock.calls.length}`);
  });

  it("applies formatForSlack before posting", async () => {
    await postToThread(mockClient, "C123", "1234.5678", "**bold**");
    expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: "*bold*" }),
    );
  });

  it("splits messages longer than 3900 chars into multiple posts", async () => {
    await postToThread(mockClient, "C123", "1234.5678", "a".repeat(4000));
    expect(mockClient.chat.postMessage.mock.calls.length).toBeGreaterThan(1);
  });

  it("prefers splitting at newlines", async () => {
    // Build text: a 2000-char line, then a newline, then a 2000-char line → 4001 total
    const text = "x".repeat(2000) + "\n" + "y".repeat(2000);
    await postToThread(mockClient, "C123", "1234.5678", text);
    expect(mockClient.chat.postMessage).toHaveBeenCalledTimes(2);
    // First chunk should be the first 2000-char line
    const firstChunk: string =
      mockClient.chat.postMessage.mock.calls[0][0].text;
    expect(firstChunk).toBe("x".repeat(2000));
  });

  it("hard-splits when no good newline break is available", async () => {
    // No newlines at all → must hard-split at 3900
    const text = "z".repeat(5000);
    await postToThread(mockClient, "C123", "1234.5678", text);
    expect(mockClient.chat.postMessage).toHaveBeenCalledTimes(2);
    const firstChunk: string =
      mockClient.chat.postMessage.mock.calls[0][0].text;
    expect(firstChunk.length).toBe(3900);
  });

  it("does not split messages exactly at the limit", async () => {
    await postToThread(mockClient, "C123", "1234.5678", "a".repeat(3900));
    expect(mockClient.chat.postMessage).toHaveBeenCalledTimes(1);
  });
});
