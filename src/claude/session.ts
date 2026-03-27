import { query, type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { consumeResponse, type ClaudeResponse } from "./response.js";

// Strip CLAUDECODE env var so the SDK doesn't think it's a nested session
const { CLAUDECODE: _, ...cleanEnv } = process.env;

/**
 * Maximum number of turns per query. Without a cap, deep exploration tasks
 * (many tool calls, nested agents, reading large file trees) can grow the
 * context until it hits the model's hard limit, crashing the session before
 * a Slack reply is ever sent.  Configurable via CLAUDE_MAX_TURNS env var.
 */
export const DEFAULT_MAX_TURNS =
  parseInt(process.env.CLAUDE_MAX_TURNS ?? "") || 200;

const sharedOptions = {
  permissionMode: "bypassPermissions" as const,
  allowDangerouslySkipPermissions: true,
  settingSources: ["user" as const, "project" as const],
  env: cleanEnv,
  maxTurns: DEFAULT_MAX_TURNS,
  stderr: (data: string) => process.stderr.write(`[claude-code] ${data}`),
};

export interface SessionOptions {
  mcpServers?: Record<string, McpServerConfig>;
}

/**
 * Prompt injected when resuming a session that hit the turn limit.
 * Asks Claude to produce a concise summary of what happened so the user
 * isn't left with a silent failure.
 */
const SUMMARY_PROMPT =
  "Your session reached the maximum turn limit before you could finish. " +
  "Please write a concise summary covering: " +
  "(1) what was accomplished, " +
  "(2) what you were in the middle of doing, and " +
  "(3) what would still need to happen to complete the original task. " +
  "Keep it brief and actionable — this will be posted back to the user.";

/**
 * Resume a session that hit the turn limit and ask it to summarise its work.
 * Uses a tiny turn budget (5) so this can never itself run away.
 */
export async function summarizeSession(
  cwd: string,
  sessionId: string,
  opts?: SessionOptions,
): Promise<ClaudeResponse> {
  const gen = query({
    prompt: SUMMARY_PROMPT,
    options: {
      ...sharedOptions,
      maxTurns: 5, // summary never needs more than a couple of turns
      cwd,
      resume: sessionId,
      ...opts,
    },
  });
  return consumeResponse(gen);
}

/**
 * Create a new Claude Code session.
 */
export async function createSession(
  prompt: string,
  cwd: string,
  opts?: SessionOptions,
  getTimeoutMs?: () => number,
): Promise<ClaudeResponse> {
  const gen = query({
    prompt,
    options: { ...sharedOptions, cwd, ...opts },
  });

  return consumeResponse(gen, getTimeoutMs);
}

/**
 * Resume an existing Claude Code session.
 */
export async function resumeSession(
  prompt: string,
  cwd: string,
  sessionId: string,
  opts?: SessionOptions,
  getTimeoutMs?: () => number,
): Promise<ClaudeResponse> {
  const gen = query({
    prompt,
    options: { ...sharedOptions, cwd, resume: sessionId, ...opts },
  });

  return consumeResponse(gen, getTimeoutMs);
}
