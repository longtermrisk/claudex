import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/* ------------------------------------------------------------------ */
/*  Module mocks                                                      */
/* ------------------------------------------------------------------ */
const mockGetSession = vi.fn();
const mockSaveSession = vi.fn();
vi.mock("../../src/store/sessions.js", () => ({
  getSession: (...args: any[]) => mockGetSession(...args),
  saveSession: (...args: any[]) => mockSaveSession(...args),
}));

const mockCreateSession = vi.fn();
const mockResumeSession = vi.fn();
const mockSummarizeSession = vi.fn();
vi.mock("../../src/claude/session.js", () => ({
  createSession: (...args: any[]) => mockCreateSession(...args),
  resumeSession: (...args: any[]) => mockResumeSession(...args),
  summarizeSession: (...args: any[]) => mockSummarizeSession(...args),
}));

vi.mock("../../src/claude/response.js", () => ({
  DEFAULT_INACTIVITY_TIMEOUT_MS: 600_000,
}));

const mockPostToThread = vi.fn();
vi.mock("../../src/slack/messages.js", () => ({
  postToThread: (...args: any[]) => mockPostToThread(...args),
  formatForSlack: (t: string) => t,
}));

vi.mock("../../src/slack/mcp-server.js", () => ({
  createSlackMcpServer: vi.fn(() => ({ mock: "mcp-server" })),
}));

const mockDownloadSlackFile = vi.fn();
vi.mock("../../src/slack/files.js", () => ({
  downloadSlackFile: (...args: any[]) => mockDownloadSlackFile(...args),
  uploadFileToSlack: vi.fn(async () => {}),
  uploadContentAsFile: vi.fn(async () => {}),
}));

vi.mock("../../src/util/file-detect.js", () => ({
  detectFilePaths: vi.fn(() => []),
}));

vi.mock("../../src/util/paths.js", () => ({
  resolveCwd: vi.fn(() => "/mock/workspace/channel"),
}));

vi.mock("../../src/util/transcribe.js", () => ({
  transcribeAudio: vi.fn(async () => "transcribed text"),
}));

import { handleMessage, activeThreads, gracefulShutdown } from "../../src/slack/events.js";
import { activeTimeouts } from "../../src/slack/tools.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */
function makeMockClient(): any {
  return {
    chat: {
      postMessage: vi.fn(async () => ({ ts: "thinking-ts" })),
      delete: vi.fn(async () => ({})),
    },
    team: {
      info: vi.fn(async () => ({ team: { name: "TestTeam" } })),
    },
    conversations: {
      info: vi.fn(async () => ({ channel: { name: "test-channel" } })),
      replies: vi.fn(async () => ({ messages: [] })),
    },
    users: {
      info: vi.fn(async (args: { user: string }) => ({
        user: { profile: { display_name: `User-${args.user}` } },
      })),
    },
    filesUploadV2: vi.fn(async () => ({})),
  };
}

function makeArgs(overrides?: any): any {
  const client = makeMockClient();
  return {
    client,
    event: {
      type: "message",
      channel: "C_TEST",
      ts: "1000.0",
      text: "Hello Claude",
      ...overrides?.event,
    },
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/*  Setup / Teardown                                                  */
/* ------------------------------------------------------------------ */
beforeEach(() => {
  vi.clearAllMocks();
  activeThreads.clear();
  activeTimeouts.clear();

  // Default: no existing session
  mockGetSession.mockReturnValue(undefined);

  // Default: Claude returns a successful response
  mockCreateSession.mockResolvedValue({
    sessionId: "new-session-id",
    text: "Claude says hello",
    isError: false,
    costUsd: 0.01,
  });
  mockResumeSession.mockResolvedValue({
    sessionId: "resumed-session-id",
    text: "Claude continues",
    isError: false,
    costUsd: 0.02,
  });

  mockPostToThread.mockResolvedValue("response-ts");
  mockDownloadSlackFile.mockResolvedValue("/tmp/downloaded/file.txt");
});

/* ------------------------------------------------------------------ */
/*  handleMessage                                                     */
/* ------------------------------------------------------------------ */
describe("handleMessage", () => {
  it("ignores messages with a subtype (e.g., message_changed)", async () => {
    const args = makeArgs({ event: { subtype: "message_changed" } });
    await handleMessage(args);
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it("ignores bot messages", async () => {
    const args = makeArgs({ event: { bot_id: "B123" } });
    await handleMessage(args);
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it("skips if thread is already being processed (concurrency guard)", async () => {
    const args = makeArgs();
    activeThreads.add("C_TEST:1000.0");
    await handleMessage(args);
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it("creates a new session for first message in thread", async () => {
    const args = makeArgs();
    await handleMessage(args);
    expect(mockCreateSession).toHaveBeenCalled();
    const prompt = mockCreateSession.mock.calls[0][0];
    expect(prompt).toContain("Hello Claude");
  });

  it("strips bot mentions from the prompt", async () => {
    const args = makeArgs({ event: { text: "<@U1234BOT> do something" } });
    await handleMessage(args);
    const prompt = mockCreateSession.mock.calls[0][0];
    expect(prompt).toContain("do something");
    expect(prompt).not.toContain("<@U1234BOT>");
  });

  it("includes channel context in prompt for first message", async () => {
    const args = makeArgs();
    await handleMessage(args);
    const prompt = mockCreateSession.mock.calls[0][0];
    expect(prompt).toContain("[Slack channel:");
    expect(prompt).toContain("C_TEST");
  });

  it("resumes an existing session on follow-up messages", async () => {
    mockGetSession.mockReturnValue({
      channelId: "C_TEST",
      threadTs: "1000.0",
      sessionId: "existing-session",
      cwd: "/tmp",
      lastResponseTs: "1001.0",
      createdAt: "",
      updatedAt: "",
    });

    const args = makeArgs({
      event: {
        channel: "C_TEST",
        ts: "1002.0",
        thread_ts: "1000.0",
        text: "follow up",
      },
    });

    // Mock conversations.replies to return a user message (aggregateMessages needs it)
    args.client.conversations.replies = vi.fn(async () => ({
      messages: [
        { ts: "1000.0", user: "U1", text: "original" },
        { ts: "1002.0", user: "U1", text: "follow up" },
      ],
    }));

    await handleMessage(args);
    expect(mockResumeSession).toHaveBeenCalled();
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it("posts the thinking indicator and removes it after response", async () => {
    const args = makeArgs();
    await handleMessage(args);

    // Should post thinking indicator
    expect(args.client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Thinking"),
      }),
    );

    // Should delete thinking indicator
    expect(args.client.chat.delete).toHaveBeenCalledWith(
      expect.objectContaining({ ts: "thinking-ts" }),
    );
  });

  it("posts the response to the thread", async () => {
    const args = makeArgs();
    await handleMessage(args);
    expect(mockPostToThread).toHaveBeenCalledWith(
      args.client,
      "C_TEST",
      "1000.0",
      "Claude says hello",
    );
  });

  it("saves the session after successful response", async () => {
    const args = makeArgs();
    await handleMessage(args);
    expect(mockSaveSession).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "C_TEST",
        threadTs: "1000.0",
        sessionId: "new-session-id",
      }),
    );
  });

  it("cleans up activeThreads in finally block", async () => {
    const args = makeArgs();
    await handleMessage(args);
    expect(activeThreads.has("C_TEST:1000.0")).toBe(false);
  });

  it("cleans up activeThreads even on error", async () => {
    mockCreateSession.mockRejectedValue(new Error("boom"));
    const args = makeArgs();
    await handleMessage(args);
    expect(activeThreads.has("C_TEST:1000.0")).toBe(false);
  });

  it("cleans up activeTimeouts in finally block", async () => {
    activeTimeouts.set("C_TEST:1000.0", 999);
    const args = makeArgs();
    await handleMessage(args);
    expect(activeTimeouts.has("C_TEST:1000.0")).toBe(false);
  });

  it("posts error message to thread on failure", async () => {
    mockCreateSession.mockRejectedValue(new Error("Session failed"));
    const args = makeArgs();
    await handleMessage(args);

    // Should post error message
    const errorCall = args.client.chat.postMessage.mock.calls.find(
      (call: any) => call[0].text?.includes("Sorry, something went wrong"),
    );
    expect(errorCall).toBeDefined();
    expect(errorCall![0].text).toContain("Session failed");
  });

  it("removes thinking indicator on error", async () => {
    mockCreateSession.mockRejectedValue(new Error("fail"));
    const args = makeArgs();
    await handleMessage(args);
    expect(args.client.chat.delete).toHaveBeenCalledWith(
      expect.objectContaining({ ts: "thinking-ts" }),
    );
  });

  it("appends file paths to prompt when files are attached", async () => {
    const args = makeArgs({
      event: {
        text: "check this file",
        files: [
          {
            url_private_download: "https://files.slack.com/a.txt",
            name: "a.txt",
            mimetype: "text/plain",
          },
        ],
      },
    });
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    await handleMessage(args);
    const prompt = mockCreateSession.mock.calls[0][0];
    expect(prompt).toContain("attached files");
    expect(prompt).toContain("/tmp/downloaded/file.txt");
  });

  it("includes channel context even for empty text", async () => {
    // Empty text still gets channel context header, so it's processed
    const args = makeArgs({ event: { text: "" } });
    await handleMessage(args);
    // The prompt will be "[Slack channel: #test-channel (C_TEST)]\n\n"
    // which is non-empty, so createSession IS called
    expect(mockCreateSession).toHaveBeenCalled();
    const prompt = mockCreateSession.mock.calls[0][0];
    expect(prompt).toContain("[Slack channel:");
  });

  it("uses thread_ts as threadTs when message is in a thread", async () => {
    const args = makeArgs({
      event: {
        channel: "C_TEST",
        ts: "2000.0",
        thread_ts: "1000.0",
        text: "reply in thread",
      },
    });
    // Mid-thread mention with no session → fetches full thread
    await handleMessage(args);
    // The thread key should use thread_ts, not ts
    expect(mockSaveSession).toHaveBeenCalledWith(
      expect.objectContaining({
        threadTs: "1000.0",
      }),
    );
  });
});

/* ------------------------------------------------------------------ */
/*  gracefulShutdown                                                  */
/* ------------------------------------------------------------------ */
describe("gracefulShutdown", () => {
  it("does nothing when no active threads", async () => {
    activeThreads.clear();
    const client = makeMockClient();
    await gracefulShutdown(client);
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  it("notifies all active threads", async () => {
    activeThreads.add("C1:100.0");
    activeThreads.add("C2:200.0");

    const client = makeMockClient();
    // Simulate threads finishing during shutdown
    setTimeout(() => {
      activeThreads.clear();
    }, 100);

    await gracefulShutdown(client, 2000);

    expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C1",
        thread_ts: "100.0",
        text: expect.stringContaining("restarting"),
      }),
    );
    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C2",
        thread_ts: "200.0",
      }),
    );
  });

  it("times out if threads don't finish", async () => {
    activeThreads.add("C_STUCK:999.0");
    const client = makeMockClient();

    const start = Date.now();
    await gracefulShutdown(client, 500); // very short timeout
    const elapsed = Date.now() - start;

    // Should have waited approximately maxWaitMs
    expect(elapsed).toBeGreaterThanOrEqual(400);
    // Clean up
    activeThreads.clear();
  });

  it("does not throw if notification fails", async () => {
    activeThreads.add("C_FAIL:111.0");
    const client = makeMockClient();
    client.chat.postMessage = vi.fn(async () => {
      throw new Error("network error");
    });

    // Simulate thread finishing
    setTimeout(() => activeThreads.clear(), 100);

    // Should not throw
    await expect(gracefulShutdown(client, 2000)).resolves.not.toThrow();
  });
});
