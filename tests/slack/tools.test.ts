import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the SDK tool() function to capture the handler
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  tool: vi.fn(
    (
      _name: string,
      _desc: string,
      _schema: any,
      handler: (...args: any[]) => any,
    ) => ({
      name: _name,
      handler,
    }),
  ),
}));

import {
  slackSendMessage,
  slackSendFile,
  slackListChannels,
  slackReadChannel,
  slackReadThread,
  slackSearch,
  setInactivityTimeout,
  activeTimeouts,
  type SlackToolContext,
} from "../../src/slack/tools.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */
function makeCtx(overrides?: Partial<SlackToolContext>): SlackToolContext {
  return {
    client: makeMockClient(),
    channelId: "C_DEFAULT",
    threadTs: "100.0",
    ...overrides,
  };
}

function makeMockClient(): any {
  return {
    chat: {
      postMessage: vi.fn(async () => ({ ts: "posted-ts" })),
      delete: vi.fn(async () => ({})),
    },
    filesUploadV2: vi.fn(async () => ({})),
    conversations: {
      list: vi.fn(async () => ({
        channels: [
          { id: "C1", name: "general", topic: { value: "General chat" }, num_members: 10 },
          { id: "C2", name: "random", topic: { value: "" }, num_members: 5 },
        ],
      })),
      history: vi.fn(async () => ({
        messages: [
          { ts: "1.0", user: "U1", text: "hello world", thread_ts: undefined, reply_count: 0 },
          { ts: "2.0", user: "U2", text: "goodbye", thread_ts: undefined, reply_count: 1 },
        ],
      })),
      replies: vi.fn(async () => ({
        messages: [
          { ts: "1.0", user: "U1", text: "parent message" },
          { ts: "1.1", user: "U2", text: "reply" },
        ],
      })),
    },
    users: {
      info: vi.fn(async (args: { user: string }) => ({
        user: {
          profile: { display_name: `User-${args.user}` },
          real_name: `Real-${args.user}`,
          name: args.user,
        },
      })),
    },
    search: {
      messages: vi.fn(async () => ({
        messages: { matches: [] },
      })),
    },
  };
}

/** Get the handler from a tool definition */
function getHandler(toolDef: any): (...args: any[]) => Promise<any> {
  return toolDef.handler;
}

/* ------------------------------------------------------------------ */
/*  slackSendMessage                                                  */
/* ------------------------------------------------------------------ */
describe("slackSendMessage", () => {
  it("sends a message to the default channel and thread", async () => {
    const ctx = makeCtx();
    const handler = getHandler(slackSendMessage(ctx));
    const result = await handler({ text: "hello" });
    expect(ctx.client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C_DEFAULT",
        thread_ts: "100.0",
        text: "hello",
      }),
    );
    expect(result.content[0].text).toContain("Message sent");
  });

  it("uses provided channel_id and thread_ts overrides", async () => {
    const ctx = makeCtx();
    const handler = getHandler(slackSendMessage(ctx));
    await handler({
      text: "hi",
      channel_id: "C_OTHER",
      thread_ts: "999.0",
    });
    expect(ctx.client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C_OTHER",
        thread_ts: "999.0",
      }),
    );
  });

  it("returns error content on failure", async () => {
    const ctx = makeCtx();
    ctx.client.chat.postMessage = vi.fn(async () => {
      throw new Error("channel_not_found");
    });
    const handler = getHandler(slackSendMessage(ctx));
    const result = await handler({ text: "hi" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Failed to send message");
    expect(result.content[0].text).toContain("channel_not_found");
  });

  it("disables link/media unfurling", async () => {
    const ctx = makeCtx();
    const handler = getHandler(slackSendMessage(ctx));
    await handler({ text: "http://example.com" });
    expect(ctx.client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        unfurl_links: false,
        unfurl_media: false,
      }),
    );
  });
});

/* ------------------------------------------------------------------ */
/*  slackSendFile                                                     */
/* ------------------------------------------------------------------ */
describe("slackSendFile", () => {
  it("uploads a file with default channel/thread", async () => {
    const ctx = makeCtx();
    const handler = getHandler(slackSendFile(ctx));
    const result = await handler({ file_path: "/tmp/test.txt" });
    expect(ctx.client.filesUploadV2).toHaveBeenCalledWith(
      expect.objectContaining({
        channel_id: "C_DEFAULT",
        thread_ts: "100.0",
        file: "/tmp/test.txt",
        filename: "test.txt",
      }),
    );
    expect(result.content[0].text).toContain("uploaded successfully");
  });

  it("uses provided filename override", async () => {
    const ctx = makeCtx();
    const handler = getHandler(slackSendFile(ctx));
    await handler({ file_path: "/tmp/test.txt", filename: "report.txt" });
    expect(ctx.client.filesUploadV2).toHaveBeenCalledWith(
      expect.objectContaining({ filename: "report.txt" }),
    );
  });

  it("returns error on upload failure", async () => {
    const ctx = makeCtx();
    ctx.client.filesUploadV2 = vi.fn(async () => {
      throw new Error("file_too_large");
    });
    const handler = getHandler(slackSendFile(ctx));
    const result = await handler({ file_path: "/tmp/big.zip" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Failed to upload");
  });
});

/* ------------------------------------------------------------------ */
/*  slackListChannels                                                 */
/* ------------------------------------------------------------------ */
describe("slackListChannels", () => {
  it("returns channel list as JSON", async () => {
    const ctx = makeCtx();
    const handler = getHandler(slackListChannels(ctx));
    const result = await handler({});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual(
      expect.objectContaining({ id: "C1", name: "general" }),
    );
  });

  it("uses default limit of 100", async () => {
    const ctx = makeCtx();
    const handler = getHandler(slackListChannels(ctx));
    await handler({});
    expect(ctx.client.conversations.list).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100, exclude_archived: true }),
    );
  });

  it("uses custom limit when provided", async () => {
    const ctx = makeCtx();
    const handler = getHandler(slackListChannels(ctx));
    await handler({ limit: 50 });
    expect(ctx.client.conversations.list).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 50 }),
    );
  });
});

/* ------------------------------------------------------------------ */
/*  slackReadChannel                                                  */
/* ------------------------------------------------------------------ */
describe("slackReadChannel", () => {
  it("reads channel history and resolves user names", async () => {
    const ctx = makeCtx();
    const handler = getHandler(slackReadChannel(ctx));
    const result = await handler({ channel_id: "C1" });
    const parsed = JSON.parse(result.content[0].text);
    // Messages should be reversed (chronological order)
    expect(parsed[0].ts).toBe("2.0");
    expect(parsed[1].ts).toBe("1.0");
    // User names should be resolved
    expect(parsed[0].user).toContain("User-");
  });

  it("defaults to 20 messages", async () => {
    const ctx = makeCtx();
    const handler = getHandler(slackReadChannel(ctx));
    await handler({ channel_id: "C1" });
    expect(ctx.client.conversations.history).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 20 }),
    );
  });
});

/* ------------------------------------------------------------------ */
/*  slackReadThread                                                   */
/* ------------------------------------------------------------------ */
describe("slackReadThread", () => {
  it("reads thread replies and resolves user names", async () => {
    const ctx = makeCtx();
    const handler = getHandler(slackReadThread(ctx));
    const result = await handler({ channel_id: "C1", thread_ts: "1.0" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].user).toContain("User-");
  });

  it("defaults to 50 replies", async () => {
    const ctx = makeCtx();
    const handler = getHandler(slackReadThread(ctx));
    await handler({ channel_id: "C1", thread_ts: "1.0" });
    expect(ctx.client.conversations.replies).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 50 }),
    );
  });
});

/* ------------------------------------------------------------------ */
/*  slackSearch – fallback mode (no SLACK_USER_TOKEN)                 */
/* ------------------------------------------------------------------ */
describe("slackSearch (history fallback)", () => {
  const origUserToken = process.env.SLACK_USER_TOKEN;

  beforeEach(() => {
    delete process.env.SLACK_USER_TOKEN;
  });

  afterEach(() => {
    if (origUserToken !== undefined) {
      process.env.SLACK_USER_TOKEN = origUserToken;
    }
  });

  it("requires channel_id when no user token is set", async () => {
    const ctx = makeCtx();
    const handler = getHandler(slackSearch(ctx));
    const result = await handler({ query: "test" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("No SLACK_USER_TOKEN");
  });

  it("searches channel history with keyword filtering", async () => {
    const ctx = makeCtx();
    const handler = getHandler(slackSearch(ctx));
    const result = await handler({ query: "hello", channel_id: "C1" });
    // "hello world" contains "hello" so it should match
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.length).toBeGreaterThanOrEqual(1);
    expect(parsed[0].text).toContain("hello");
  });

  it("returns message when no matches found", async () => {
    const ctx = makeCtx();
    ctx.client.conversations.history = vi.fn(async () => ({
      messages: [{ ts: "1.0", user: "U1", text: "unrelated" }],
    }));
    const handler = getHandler(slackSearch(ctx));
    const result = await handler({
      query: "nonexistent",
      channel_id: "C1",
    });
    expect(result.content[0].text).toContain("No messages matching");
  });
});

/* ------------------------------------------------------------------ */
/*  setInactivityTimeout                                              */
/* ------------------------------------------------------------------ */
describe("setInactivityTimeout", () => {
  beforeEach(() => {
    activeTimeouts.clear();
  });

  it("sets the timeout in the activeTimeouts map", async () => {
    const ctx = makeCtx();
    const handler = getHandler(setInactivityTimeout(ctx));
    await handler({ minutes: 30 });
    const key = `${ctx.channelId}:${ctx.threadTs}`;
    expect(activeTimeouts.get(key)).toBe(30 * 60 * 1000);
  });

  it("enforces minimum of 1 minute", async () => {
    const ctx = makeCtx();
    const handler = getHandler(setInactivityTimeout(ctx));
    await handler({ minutes: 0 });
    const key = `${ctx.channelId}:${ctx.threadTs}`;
    expect(activeTimeouts.get(key)).toBe(1 * 60 * 1000);
  });

  it("returns confirmation message", async () => {
    const ctx = makeCtx();
    const handler = getHandler(setInactivityTimeout(ctx));
    const result = await handler({ minutes: 15 });
    expect(result.content[0].text).toContain("15 minutes");
  });

  it("uses singular 'minute' for 1", async () => {
    const ctx = makeCtx();
    const handler = getHandler(setInactivityTimeout(ctx));
    const result = await handler({ minutes: 1 });
    expect(result.content[0].text).toMatch(/1 minute(?!s)/);
  });
});

/* ------------------------------------------------------------------ */
/*  Retry logic (tested via slackSendMessage)                         */
/* ------------------------------------------------------------------ */
describe("retry logic", () => {
  it("retries on 'stream closed' error", async () => {
    const ctx = makeCtx();
    let attempt = 0;
    ctx.client.chat.postMessage = vi.fn(async () => {
      attempt++;
      if (attempt === 1) throw new Error("stream closed");
      return { ts: "ok" };
    });
    const handler = getHandler(slackSendMessage(ctx));
    const result = await handler({ text: "test" });
    expect(result.content[0].text).toContain("Message sent");
    expect(attempt).toBe(2);
  });

  it("retries on 'ECONNRESET' error", async () => {
    const ctx = makeCtx();
    let attempt = 0;
    ctx.client.chat.postMessage = vi.fn(async () => {
      attempt++;
      if (attempt === 1) throw new Error("read ECONNRESET");
      return { ts: "ok" };
    });
    const handler = getHandler(slackSendMessage(ctx));
    const result = await handler({ text: "test" });
    expect(result.content[0].text).toContain("Message sent");
  });

  it("retries on 'socket hang up' error", async () => {
    const ctx = makeCtx();
    let attempt = 0;
    ctx.client.chat.postMessage = vi.fn(async () => {
      attempt++;
      if (attempt === 1) throw new Error("socket hang up");
      return { ts: "ok" };
    });
    const handler = getHandler(slackSendMessage(ctx));
    const result = await handler({ text: "test" });
    expect(result.content[0].text).toContain("Message sent");
  });

  it("retries on 'ETIMEDOUT' error", async () => {
    const ctx = makeCtx();
    let attempt = 0;
    ctx.client.chat.postMessage = vi.fn(async () => {
      attempt++;
      if (attempt === 1) throw new Error("connect ETIMEDOUT");
      return { ts: "ok" };
    });
    const handler = getHandler(slackSendMessage(ctx));
    const result = await handler({ text: "test" });
    expect(result.content[0].text).toContain("Message sent");
  });

  it("does NOT retry on non-transient errors", async () => {
    const ctx = makeCtx();
    ctx.client.chat.postMessage = vi.fn(async () => {
      throw new Error("channel_not_found");
    });
    const handler = getHandler(slackSendMessage(ctx));
    const result = await handler({ text: "test" });
    expect(result.isError).toBe(true);
    // Should have only been called once (no retry)
    expect(ctx.client.chat.postMessage).toHaveBeenCalledTimes(1);
  });

  it("gives up after max retry attempts", async () => {
    const ctx = makeCtx();
    ctx.client.chat.postMessage = vi.fn(async () => {
      throw new Error("stream closed");
    });
    const handler = getHandler(slackSendMessage(ctx));
    const result = await handler({ text: "test" });
    // After 3 attempts (maxAttempts default), should return error
    expect(result.isError).toBe(true);
    expect(ctx.client.chat.postMessage).toHaveBeenCalledTimes(3);
  });
});
