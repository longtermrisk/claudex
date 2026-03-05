import { query, type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { consumeResponse, type ClaudeResponse } from "./response.js";

// Strip CLAUDECODE env var so the SDK doesn't think it's a nested session
const { CLAUDECODE: _, ...cleanEnv } = process.env;

const sharedOptions = {
  permissionMode: "bypassPermissions" as const,
  allowDangerouslySkipPermissions: true,
  settingSources: ["user" as const, "project" as const],
  env: cleanEnv,
  stderr: (data: string) => process.stderr.write(`[claude-code] ${data}`),
};

export interface SessionOptions {
  mcpServers?: Record<string, McpServerConfig>;
}

/**
 * Create a new Claude Code session.
 */
export async function createSession(
  prompt: string,
  cwd: string,
  opts?: SessionOptions,
): Promise<ClaudeResponse> {
  const gen = query({
    prompt,
    options: { ...sharedOptions, cwd, ...opts },
  });

  return consumeResponse(gen);
}

/**
 * Resume an existing Claude Code session.
 */
export async function resumeSession(
  prompt: string,
  cwd: string,
  sessionId: string,
  opts?: SessionOptions,
): Promise<ClaudeResponse> {
  const gen = query({
    prompt,
    options: { ...sharedOptions, cwd, resume: sessionId, ...opts },
  });

  return consumeResponse(gen);
}
