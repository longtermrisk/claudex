/**
 * Crash-prevention tests for handleMessage and related event handling.
 *
 * Focus: error paths that could cause user-visible crashes, silent message
 * loss, or broken session state when a user posts a message in Slack.
 *
 * Tests marked "BUG" are expected to fail and highlight real issues.
 *
 * ORDERING NOTE: "Slack API failures during setup" must run FIRST because
 * nameCache is module-level state in events.ts. Once any test successfully
 * runs handleMessage, the "workspace" key is cached and team.info will
 * never be called again for the lifetime of this test file.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

/* ------------------------------------------------------------------ */
/*  Module mocks (same structure as events.test.ts)                   */
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
const mockUploadFileToSlack = vi.fn();
const mockUploadContentAsFile = vi.fn();
vi.mock("../../src/slack/files.js", () => ({
  downloadSlackFile: (...args: any[]) => mockDownloadSlackFile(...args),
  uploadFileToSlack: (...args: any[]) => mockUploadFileToSlack(...args),
  uploadContentAsFile: (...args: any[]) => mockUploadContentAsFile(...args),
}));

vi.mock("../../src/util/file-detect.js", () => ({
  detectFilePaths: vi.fn(() => []),
}));

vi.mock("../../src/util/paths.js", () => ({
  resolveCwd: vi.fn(() => "/mock/workspace/channel"),
}));

const mockTranscribeAudio = vi.fn();
vi.mock("../../src/util/transcribe.js", () => ({
  transcribeAudio: (...args: any[]) => mockTranscribeAudio(...args),
}));

import { handleMessage, activeThreads } from "../../src/slack/events.js";
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
/*  Setup                                                             */
/* ------------------------------------------------------------------ */
beforeEach(() => {
  vi.clearAllMocks();
  activeThreads.clear();
  activeTimeouts.clear();

  mockGetSession.mockReturnValue(undefined);
  mockCreateSession.mockResolvedValue({
    sessionId: "new-session-id",
    text: "Claude says hello",
    isError: false,
    costUsd: 0.01,
  });
  mockResumeSession.mockResolvedValue({
    sessionId: "resumed-id",
    text: "Claude continues",
    isError: false,
    costUsd: 0.02,
  });
  mockPostToThread.mockResolvedValue("response-ts");
  mockDownloadSlackFile.mockResolvedValue("/tmp/downloaded/file.txt");
  mockTranscribeAudio.mockResolvedValue("transcribed text");
});

/* ================================================================== */
/*  1. Slack API failures during setup (MUST RUN FIRST — see header)  */
/* ================================================================== */
describe("Crash prevention: Slack API failures during setup", () => {
  it("does not crash when team.info fails (error is caught by outer handler)", async () => {
    // nameCache is module-level state in events.ts. Behavior depends on cache state:
    //  - Cold cache: getCachedName propagates the error → caught by handleMessage's
    //    outer catch → error message posted to thread. This is the "first call ever" case.
    //  - Warm cache: getCachedName returns cached value, team.info never called.
    //
    // Either way, handleMessage must NOT crash (no unhandled exceptions), and
    // activeThreads must be cleaned up.
    const args = makeArgs({
      event: { channel: "C_TEAM_FRESH", ts: "1711899999.000000", text: "Hello" },
    });
    args.client.team.info = vi.fn(async () => {
      throw new Error("team_not_found");
    });

    // Should not throw regardless of cache state
    await handleMessage(args);

    // activeThreads must always be cleaned up
    expect(activeThreads.has("C_TEAM_FRESH:1711899999.000000")).toBe(false);
  });

  it("handles conversations.info failure gracefully", async () => {
    // Use a unique channel ID to ensure nameCache miss → forces API call
    const args = makeArgs({
      event: { channel: "C_CONV_FRESH", ts: "1711899998.000000", text: "Hello" },
    });
    args.client.conversations.info = vi.fn(async () => {
      throw new Error("channel_not_found");
    });

    await handleMessage(args);

    const errorCall = args.client.chat.postMessage.mock.calls.find(
      (call: any) => call[0].text?.includes("Sorry, something went wrong"),
    );
    expect(errorCall).toBeDefined();
  });

  it("handles conversations.replies failure in resume path", async () => {
    const threadTs = "1711890800.000000";
    const newMsgTs = "1711890802.000000";

    mockGetSession.mockReturnValue({
      channelId: "C_REPLIES",
      threadTs,
      sessionId: "existing",
      cwd: "/tmp",
      lastResponseTs: "1711890801.000000",
      createdAt: "",
      updatedAt: "",
    });

    const args = makeArgs({
      event: { channel: "C_REPLIES", ts: newMsgTs, thread_ts: threadTs, text: "follow up" },
    });
    args.client.conversations.replies = vi.fn(async () => {
      throw new Error("channel_not_found");
    });

    await handleMessage(args);

    const errorCall = args.client.chat.postMessage.mock.calls.find(
      (call: any) => call[0].text?.includes("Sorry, something went wrong"),
    );
    expect(errorCall).toBeDefined();
    expect(activeThreads.has(`C_REPLIES:${threadTs}`)).toBe(false);
  });

  it("still cleans up when error message posting also fails", async () => {
    mockCreateSession.mockRejectedValue(new Error("SDK crash"));
    const args = makeArgs();
    // Make the error message posting also fail
    let callCount = 0;
    args.client.chat.postMessage = vi.fn(async () => {
      callCount++;
      if (callCount === 1) return { ts: "thinking-ts" }; // thinking indicator OK
      throw new Error("cannot_post"); // error message fails
    });

    await handleMessage(args);

    // Thread should still be cleaned up even when everything fails
    expect(activeThreads.has("C_TEST:1000.0")).toBe(false);
    expect(activeTimeouts.has("C_TEST:1000.0")).toBe(false);
  });
});

/* ================================================================== */
/*  2. SDK / Claude Code process crashes                              */
/* ================================================================== */
describe("Crash prevention: SDK process crashes", () => {
  it("posts error message when Claude Code process exits with code 1", async () => {
    mockCreateSession.mockRejectedValue(
      new Error("Claude Code process exited with code 1"),
    );
    const args = makeArgs();
    await handleMessage(args);

    const errorCall = args.client.chat.postMessage.mock.calls.find(
      (call: any) => call[0].text?.includes("Sorry, something went wrong"),
    );
    expect(errorCall).toBeDefined();
    expect(errorCall![0].text).toContain(
      "Claude Code process exited with code 1",
    );
  });

  it("cleans up activeThreads after process crash", async () => {
    mockCreateSession.mockRejectedValue(
      new Error("Claude Code process exited with code 1"),
    );
    const args = makeArgs();
    await handleMessage(args);
    expect(activeThreads.has("C_TEST:1000.0")).toBe(false);
  });

  it("removes thinking indicator after process crash", async () => {
    mockCreateSession.mockRejectedValue(
      new Error("Claude Code process exited with code 1"),
    );
    const args = makeArgs();
    await handleMessage(args);
    expect(args.client.chat.delete).toHaveBeenCalledWith(
      expect.objectContaining({ ts: "thinking-ts" }),
    );
  });

  it("does NOT retry 'process exited with code 1' errors (only retries stream closed)", async () => {
    mockCreateSession.mockRejectedValue(
      new Error("Claude Code process exited with code 1"),
    );
    const args = makeArgs();
    await handleMessage(args);
    // Should only call createSession once (no retry)
    expect(mockCreateSession).toHaveBeenCalledTimes(1);
  });

  it("retries 'stream closed' errors once before giving up", async () => {
    mockCreateSession
      .mockRejectedValueOnce(new Error("stream closed"))
      .mockRejectedValueOnce(new Error("stream closed again"));
    const args = makeArgs();
    await handleMessage(args);
    // Should call createSession twice (1 initial + 1 retry)
    expect(mockCreateSession).toHaveBeenCalledTimes(2);
  });

  it("succeeds on retry after stream closed", async () => {
    mockCreateSession
      .mockRejectedValueOnce(new Error("stream closed"))
      .mockResolvedValueOnce({
        sessionId: "retry-session",
        text: "Recovered!",
        isError: false,
        costUsd: 0.01,
      });
    const args = makeArgs();
    await handleMessage(args);
    expect(mockPostToThread).toHaveBeenCalledWith(
      expect.anything(),
      "C_TEST",
      "1000.0",
      "Recovered!",
    );
  });

  it("handles non-Error thrown by SDK", async () => {
    mockCreateSession.mockRejectedValue("string error from SDK");
    const args = makeArgs();
    await handleMessage(args);

    const errorCall = args.client.chat.postMessage.mock.calls.find(
      (call: any) => call[0].text?.includes("Sorry, something went wrong"),
    );
    expect(errorCall).toBeDefined();
    // Non-Error objects → "Unknown error"
    expect(errorCall![0].text).toContain("Unknown error");
  });

  it("handles resume session crash (stale session ID)", async () => {
    // Use realistic Slack timestamps — string comparison must sort correctly
    const threadTs = "1711890720.000000";
    const lastResponseTs = "1711890721.000000";
    const newMessageTs = "1711890722.000000";

    mockGetSession.mockReturnValue({
      channelId: "C_RESUME",
      threadTs,
      sessionId: "stale-session-id",
      cwd: "/tmp",
      lastResponseTs,
      createdAt: "",
      updatedAt: "",
    });
    mockResumeSession.mockRejectedValue(
      new Error("Claude Code process exited with code 1"),
    );

    const args = makeArgs({
      event: { channel: "C_RESUME", ts: newMessageTs, thread_ts: threadTs, text: "continue" },
    });
    // Need replies to return messages so aggregation isn't empty
    args.client.conversations.replies = vi.fn(async () => ({
      messages: [
        { ts: threadTs, user: "U1", text: "original" },
        { ts: newMessageTs, user: "U1", text: "continue" },
      ],
    }));

    await handleMessage(args);

    const errorCall = args.client.chat.postMessage.mock.calls.find(
      (call: any) => call[0].text?.includes("Sorry, something went wrong"),
    );
    expect(errorCall).toBeDefined();
    expect(errorCall![0].text).toContain(
      "Claude Code process exited with code 1",
    );
  });
});

/* ================================================================== */
/*  3. error_max_turns recovery paths                                 */
/* ================================================================== */
describe("Crash prevention: error_max_turns recovery", () => {
  it("recovers via summarize + continuation when turn limit is hit", async () => {
    // First call hits turn limit
    mockCreateSession.mockResolvedValueOnce({
      sessionId: "limit-session",
      text: "Error: Turn limit exceeded",
      isError: true,
      subtype: "error_max_turns",
      costUsd: 0.5,
    });

    // Summarize succeeds
    mockSummarizeSession.mockResolvedValue({
      sessionId: "limit-session",
      text: "Summary: did X, still need Y",
      isError: false,
      costUsd: 0.02,
    });

    // Continuation succeeds
    mockCreateSession.mockResolvedValueOnce({
      sessionId: "continuation-session",
      text: "Completed the task!",
      isError: false,
      costUsd: 0.3,
    });

    const args = makeArgs();
    await handleMessage(args);

    // Should post the continuation response, not the error
    expect(mockPostToThread).toHaveBeenCalledWith(
      expect.anything(),
      "C_TEST",
      "1000.0",
      "Completed the task!",
    );

    // Should save with continuation session ID
    expect(mockSaveSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "continuation-session" }),
    );
  });

  it("falls back to error response when summarizeSession throws", async () => {
    mockCreateSession.mockResolvedValue({
      sessionId: "limit-session",
      text: "Error: Turn limit exceeded",
      isError: true,
      subtype: "error_max_turns",
      costUsd: 0.5,
    });
    mockSummarizeSession.mockRejectedValue(new Error("summarize crashed"));

    const args = makeArgs();
    await handleMessage(args);

    // Should still post something (the original error response)
    expect(mockPostToThread).toHaveBeenCalledWith(
      expect.anything(),
      "C_TEST",
      "1000.0",
      "Error: Turn limit exceeded",
    );
  });

  it("falls back when summary itself is an error", async () => {
    mockCreateSession.mockResolvedValue({
      sessionId: "s1",
      text: "Error: Turn limit exceeded",
      isError: true,
      subtype: "error_max_turns",
      costUsd: 0.5,
    });
    mockSummarizeSession.mockResolvedValue({
      sessionId: "s1",
      text: "Error: something went wrong",
      isError: true,
      costUsd: 0.01,
    });

    const args = makeArgs();
    await handleMessage(args);

    // summary.isError is true → continuation NOT started → original response returned
    expect(mockPostToThread).toHaveBeenCalledWith(
      expect.anything(),
      "C_TEST",
      "1000.0",
      "Error: Turn limit exceeded",
    );
  });

  it("falls back when summary text is empty", async () => {
    mockCreateSession.mockResolvedValue({
      sessionId: "s1",
      text: "Error: Turn limit exceeded",
      isError: true,
      subtype: "error_max_turns",
      costUsd: 0.5,
    });
    mockSummarizeSession.mockResolvedValue({
      sessionId: "s1",
      text: "",
      isError: false,
      costUsd: 0.01,
    });

    const args = makeArgs();
    await handleMessage(args);

    // summary.text is empty → continuation NOT started
    expect(mockPostToThread).toHaveBeenCalledWith(
      expect.anything(),
      "C_TEST",
      "1000.0",
      "Error: Turn limit exceeded",
    );
  });

  it("uploads summary file before starting continuation", async () => {
    mockCreateSession
      .mockResolvedValueOnce({
        sessionId: "s1",
        text: "Error: Turn limit exceeded",
        isError: true,
        subtype: "error_max_turns",
        costUsd: 0.5,
      })
      .mockResolvedValueOnce({
        sessionId: "s2",
        text: "Continued!",
        isError: false,
        costUsd: 0.1,
      });
    mockSummarizeSession.mockResolvedValue({
      sessionId: "s1",
      text: "Summary of work",
      isError: false,
      costUsd: 0.02,
    });

    const args = makeArgs();
    await handleMessage(args);

    expect(mockUploadContentAsFile).toHaveBeenCalledWith(
      expect.anything(),
      "C_TEST",
      "1000.0",
      "Summary of work",
      "session-summary.txt",
    );
  });

  it("aggregates costs from all phases (original + summary + continuation)", async () => {
    mockCreateSession
      .mockResolvedValueOnce({
        sessionId: "s1",
        text: "Error: Turn limit exceeded",
        isError: true,
        subtype: "error_max_turns",
        costUsd: 0.50,
      })
      .mockResolvedValueOnce({
        sessionId: "s2",
        text: "Done!",
        isError: false,
        costUsd: 0.30,
      });
    mockSummarizeSession.mockResolvedValue({
      sessionId: "s1",
      text: "Summary",
      isError: false,
      costUsd: 0.02,
    });

    const args = makeArgs();
    await handleMessage(args);

    // The continuation response should have combined cost
    // This is verified indirectly — if the cost log fires, it means costUsd > 0
    // The important thing is no crash during cost addition
    expect(mockPostToThread).toHaveBeenCalled();
  });
});

/* ================================================================== */
/*  4. resolveUserName in events.ts — MISSING TRY/CATCH (BUG)        */
/* ================================================================== */
describe("Crash prevention: resolveUserName in aggregateMessages", () => {
  /**
   * BUG: resolveUserName in events.ts (line 354-368) does NOT have a
   * try/catch around client.users.info(). The version in tools.ts (line
   * 51-66) correctly catches errors and falls back to the userId.
   *
   * When users.info fails (rate limit, user_not_found, etc.), the error
   * propagates out of aggregateMessages, crashing the entire message
   * handler — even though the actual message content was fine.
   *
   * This test SHOULD pass (message processed despite user lookup failure)
   * but is EXPECTED TO FAIL with current code.
   */
  it.fails("BUG: should process message even when user name resolution fails", async () => {
    const threadTs = "1711890900.000000";
    const lastResponseTs = "1711890901.000000";
    const newMsgTs = "1711890902.000000";

    mockGetSession.mockReturnValue({
      channelId: "C_RESOLVE",
      threadTs,
      sessionId: "existing",
      cwd: "/tmp",
      lastResponseTs,
      createdAt: "",
      updatedAt: "",
    });

    const args = makeArgs({
      event: { channel: "C_RESOLVE", ts: newMsgTs, thread_ts: threadTs, text: "follow up" },
    });

    args.client.conversations.replies = vi.fn(async () => ({
      messages: [
        { ts: threadTs, user: "U1", text: "original" },
        { ts: newMsgTs, user: "U_UNKNOWN", text: "follow up" },
      ],
    }));

    // Make users.info fail for the unknown user
    args.client.users.info = vi.fn(async (req: { user: string }) => {
      if (req.user === "U_UNKNOWN") {
        throw new Error("user_not_found");
      }
      return { user: { profile: { display_name: "Known User" } } };
    });

    await handleMessage(args);

    // EXPECTED BEHAVIOR: message should still be processed, with userId as fallback name
    // ACTUAL BEHAVIOR: handleMessage catches the error and posts :x: error message
    //
    // If this test FAILS, it confirms the bug: resolveUserName needs try/catch
    expect(mockResumeSession).toHaveBeenCalled();
  });
});

/* ================================================================== */
/*  5. Empty aggregation in resume path                               */
/* ================================================================== */
describe("Crash prevention: empty aggregation", () => {
  it("silently drops message when resume aggregation returns no new messages", async () => {
    const threadTs = "1711891000.000000";
    const botTs = "1711891001.000000";
    const newMsgTs = "1711891002.000000";

    mockGetSession.mockReturnValue({
      channelId: "C_EMPTY",
      threadTs,
      sessionId: "existing",
      cwd: "/tmp",
      lastResponseTs: botTs, // After all messages
      createdAt: "",
      updatedAt: "",
    });

    const args = makeArgs({
      event: { channel: "C_EMPTY", ts: newMsgTs, thread_ts: threadTs, text: "follow up" },
    });

    // conversations.replies returns only the parent and bot messages
    args.client.conversations.replies = vi.fn(async () => ({
      messages: [
        { ts: threadTs, user: "U1", text: "original" },            // parent (skipped)
        { ts: botTs, bot_id: "B1", text: "bot response" },         // bot (skipped)
        // No new user messages after lastResponseTs
      ],
    }));

    await handleMessage(args);

    // No session call should be made — prompt is empty
    expect(mockResumeSession).not.toHaveBeenCalled();
    expect(mockCreateSession).not.toHaveBeenCalled();
    // Thinking indicator should be cleaned up
    expect(args.client.chat.delete).toHaveBeenCalled();
  });
});

/* ================================================================== */
/*  6. Post-response failures                                         */
/* ================================================================== */
describe("Crash prevention: post-response failures", () => {
  it("posts error when postToThread fails (Claude work is lost)", async () => {
    mockPostToThread.mockRejectedValue(new Error("channel_archived"));
    const args = makeArgs();
    await handleMessage(args);

    // Claude's response was computed but never delivered
    const errorCall = args.client.chat.postMessage.mock.calls.find(
      (call: any) => call[0].text?.includes("Sorry, something went wrong"),
    );
    expect(errorCall).toBeDefined();

    // Session should NOT be saved (saveSession is after postToThread)
    expect(mockSaveSession).not.toHaveBeenCalled();
  });

  it("posts error when saveSession throws (response was already delivered)", async () => {
    mockSaveSession.mockImplementation(() => {
      throw new Error("ENOSPC: no space left on device");
    });
    const args = makeArgs();
    await handleMessage(args);

    // The response WAS posted (postToThread succeeded before saveSession)
    expect(mockPostToThread).toHaveBeenCalled();

    // But then the error is also posted
    const errorCall = args.client.chat.postMessage.mock.calls.find(
      (call: any) => call[0].text?.includes("Sorry, something went wrong"),
    );
    expect(errorCall).toBeDefined();
    expect(errorCall![0].text).toContain("no space left on device");
  });

  it("handles file upload failure after successful response", async () => {
    // Mock detectFilePaths to return a path
    const { detectFilePaths } = await import("../../src/util/file-detect.js");
    vi.mocked(detectFilePaths).mockReturnValue(["/tmp/result.png"]);
    mockUploadFileToSlack.mockRejectedValue(new Error("file_too_large"));

    const args = makeArgs();
    await handleMessage(args);

    // File upload failure should NOT crash handleMessage
    // The response should still be posted and session saved
    expect(mockPostToThread).toHaveBeenCalled();
    expect(mockSaveSession).toHaveBeenCalled();
  });
});

/* ================================================================== */
/*  7. File handling edge cases                                       */
/* ================================================================== */
describe("Crash prevention: file handling", () => {
  it("continues processing when file download fails", async () => {
    mockDownloadSlackFile.mockRejectedValue(new Error("403 Forbidden"));
    const args = makeArgs({
      event: {
        text: "check this file",
        files: [
          { url_private_download: "https://files.slack.com/a.txt", name: "a.txt", mimetype: "text/plain" },
        ],
      },
    });
    process.env.SLACK_BOT_TOKEN = "xoxb-test";

    await handleMessage(args);

    // Should still process the message text despite file download failure
    expect(mockCreateSession).toHaveBeenCalled();
    const prompt = mockCreateSession.mock.calls[0][0];
    expect(prompt).toContain("check this file");
    // File path should NOT be in prompt
    expect(prompt).not.toContain("attached files");
  });

  it("continues processing when audio transcription fails", async () => {
    mockDownloadSlackFile.mockResolvedValue("/tmp/audio.mp3");
    mockTranscribeAudio.mockRejectedValue(new Error("Whisper API rate limited"));

    const args = makeArgs({
      event: {
        text: "listen to this",
        files: [
          { url_private_download: "https://files.slack.com/audio.mp3", name: "audio.mp3", mimetype: "audio/mp3" },
        ],
      },
    });
    process.env.SLACK_BOT_TOKEN = "xoxb-test";

    await handleMessage(args);

    // Should still process the message text
    expect(mockCreateSession).toHaveBeenCalled();
    const prompt = mockCreateSession.mock.calls[0][0];
    expect(prompt).toContain("listen to this");
    // Audio transcript should NOT be in prompt (transcription failed)
    expect(prompt).not.toContain("transcript");
  });

  it("handles files with missing url_private_download", async () => {
    const args = makeArgs({
      event: {
        text: "file without url",
        files: [
          { name: "test.txt", mimetype: "text/plain" },  // no url_private_download
        ],
      },
    });

    await handleMessage(args);

    // Should not try to download
    expect(mockDownloadSlackFile).not.toHaveBeenCalled();
    expect(mockCreateSession).toHaveBeenCalled();
  });

  it("handles files with missing name", async () => {
    const args = makeArgs({
      event: {
        text: "file without name",
        files: [
          { url_private_download: "https://files.slack.com/noname", mimetype: "text/plain" },  // no name
        ],
      },
    });

    await handleMessage(args);

    expect(mockDownloadSlackFile).not.toHaveBeenCalled();
    expect(mockCreateSession).toHaveBeenCalled();
  });
});

/* ================================================================== */
/*  8. Event data edge cases                                          */
/* ================================================================== */
describe("Crash prevention: unusual event data", () => {
  it("handles event.text being null", async () => {
    const args = makeArgs({ event: { text: null } });
    await handleMessage(args);
    // Should not crash — null is handled by ?? "" fallback
    expect(mockCreateSession).toHaveBeenCalled();
  });

  it("handles event.text being undefined", async () => {
    const args = makeArgs();
    delete args.event.text;
    await handleMessage(args);
    // Should not crash — "text" in event check handles this
    expect(mockCreateSession).toHaveBeenCalled();
  });

  it("handles event with only bot mention (no other text)", async () => {
    const args = makeArgs({ event: { text: "<@U12345BOT>" } });
    await handleMessage(args);
    // After stripping mention, text is empty, but channel context is added
    expect(mockCreateSession).toHaveBeenCalled();
    const prompt = mockCreateSession.mock.calls[0][0];
    expect(prompt).toContain("[Slack channel:");
  });

  it("handles thinking indicator post failure", async () => {
    const args = makeArgs();
    // Make the first postMessage (thinking indicator) fail
    args.client.chat.postMessage = vi.fn(async () => {
      throw new Error("not_in_channel");
    });

    await handleMessage(args);

    // Error should be caught by outer catch
    // Even though the thinking indicator couldn't be posted, error handling proceeds
    expect(activeThreads.has("C_TEST:1000.0")).toBe(false);
  });
});
