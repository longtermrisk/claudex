import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the SDK before importing session module
const mockQuery = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (...args: any[]) => mockQuery(...args),
}));

const mockConsumeResponse = vi.fn();
vi.mock("../../src/claude/response.js", () => ({
  consumeResponse: (...args: any[]) => mockConsumeResponse(...args),
  DEFAULT_INACTIVITY_TIMEOUT_MS: 600_000,
}));

import {
  createSession,
  resumeSession,
  summarizeSession,
  DEFAULT_MAX_TURNS,
} from "../../src/claude/session.js";

describe("session", () => {
  const fakeResponse = {
    sessionId: "s1",
    text: "Done",
    isError: false,
    costUsd: 0.01,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockReturnValue("fake-generator");
    mockConsumeResponse.mockResolvedValue(fakeResponse);
  });

  /* ---------------------------------------------------------------- */
  /*  DEFAULT_MAX_TURNS                                               */
  /* ---------------------------------------------------------------- */
  describe("DEFAULT_MAX_TURNS", () => {
    it("defaults to 200 when env var is not set", () => {
      expect(DEFAULT_MAX_TURNS).toBe(200);
    });
  });

  /* ---------------------------------------------------------------- */
  /*  createSession                                                   */
  /* ---------------------------------------------------------------- */
  describe("createSession", () => {
    it("calls query with prompt and cwd", async () => {
      await createSession("hello", "/tmp/work");
      expect(mockQuery).toHaveBeenCalledWith({
        prompt: "hello",
        options: expect.objectContaining({
          cwd: "/tmp/work",
          model: "claude-opus-4-6",
          permissionMode: "bypassPermissions",
          maxTurns: DEFAULT_MAX_TURNS,
        }),
      });
    });

    it("passes the generator to consumeResponse", async () => {
      await createSession("hello", "/tmp/work");
      // When no getTimeoutMs is provided, consumeResponse is called with (gen, undefined)
      expect(mockConsumeResponse).toHaveBeenCalledTimes(1);
      expect(mockConsumeResponse.mock.calls[0][0]).toBe("fake-generator");
    });

    it("returns the response from consumeResponse", async () => {
      const result = await createSession("hello", "/tmp/work");
      expect(result).toEqual(fakeResponse);
    });

    it("passes MCP servers through options", async () => {
      const mcpServers = { "slack-tools": { fake: true } as any };
      await createSession("hello", "/tmp/work", { mcpServers });
      expect(mockQuery).toHaveBeenCalledWith({
        prompt: "hello",
        options: expect.objectContaining({
          mcpServers: { "slack-tools": { fake: true } },
        }),
      });
    });

    it("passes custom getTimeoutMs to consumeResponse", async () => {
      const getTimeout = () => 30_000;
      await createSession("hello", "/tmp/work", undefined, getTimeout);
      expect(mockConsumeResponse).toHaveBeenCalledWith(
        "fake-generator",
        getTimeout,
      );
    });

    it("does not include resume option", async () => {
      await createSession("hello", "/tmp/work");
      const options = mockQuery.mock.calls[0][0].options;
      expect(options.resume).toBeUndefined();
    });

    it("strips CLAUDECODE from env passed to SDK", async () => {
      await createSession("hello", "/tmp/work");
      const options = mockQuery.mock.calls[0][0].options;
      expect(options.env).not.toHaveProperty("CLAUDECODE");
    });
  });

  /* ---------------------------------------------------------------- */
  /*  resumeSession                                                   */
  /* ---------------------------------------------------------------- */
  describe("resumeSession", () => {
    it("calls query with resume option set to sessionId", async () => {
      await resumeSession("continue", "/tmp/work", "prev-session-id");
      expect(mockQuery).toHaveBeenCalledWith({
        prompt: "continue",
        options: expect.objectContaining({
          cwd: "/tmp/work",
          resume: "prev-session-id",
        }),
      });
    });

    it("passes MCP servers and getTimeoutMs", async () => {
      const mcpServers = { tools: {} as any };
      const getTimeout = () => 60_000;
      await resumeSession("msg", "/cwd", "sid", { mcpServers }, getTimeout);
      expect(mockQuery).toHaveBeenCalledWith({
        prompt: "msg",
        options: expect.objectContaining({
          mcpServers: { tools: {} },
          resume: "sid",
        }),
      });
      expect(mockConsumeResponse).toHaveBeenCalledWith(
        "fake-generator",
        getTimeout,
      );
    });
  });

  /* ---------------------------------------------------------------- */
  /*  summarizeSession                                                */
  /* ---------------------------------------------------------------- */
  describe("summarizeSession", () => {
    it("resumes the session with the summary prompt", async () => {
      await summarizeSession("/tmp/work", "sid-to-summarize");
      expect(mockQuery).toHaveBeenCalledWith({
        prompt: expect.stringContaining("maximum turn limit"),
        options: expect.objectContaining({
          cwd: "/tmp/work",
          resume: "sid-to-summarize",
        }),
      });
    });

    it("uses a small turn budget (5) for summaries", async () => {
      await summarizeSession("/tmp/work", "sid");
      const options = mockQuery.mock.calls[0][0].options;
      expect(options.maxTurns).toBe(5);
    });

    it("passes MCP servers when provided", async () => {
      const mcpServers = { mcp: {} as any };
      await summarizeSession("/tmp/work", "sid", { mcpServers });
      expect(mockQuery).toHaveBeenCalledWith({
        prompt: expect.any(String),
        options: expect.objectContaining({
          mcpServers: { mcp: {} },
        }),
      });
    });

    it("calls consumeResponse without custom timeout", async () => {
      await summarizeSession("/tmp/work", "sid");
      // consumeResponse should be called with just the generator (no getTimeoutMs)
      expect(mockConsumeResponse).toHaveBeenCalledWith("fake-generator");
    });

    it("summary prompt mentions what was accomplished and what's left", async () => {
      await summarizeSession("/tmp/work", "sid");
      const prompt = mockQuery.mock.calls[0][0].prompt;
      expect(prompt).toContain("what was accomplished");
      expect(prompt).toContain("still need to happen");
    });
  });
});
