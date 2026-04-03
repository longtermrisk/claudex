import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { WebClient } from "@slack/web-api";
import {
  slackSendMessage,
  slackSendFile,
  slackListChannels,
  slackReadChannel,
  slackReadThread,
  slackSearch,
  setInactivityTimeout,
  type SlackToolContext,
} from "./tools.js";

/**
 * Create an in-process MCP server with Slack tools bound to a specific thread context.
 * Each query() call should get a fresh server so the tools default to the right channel/thread.
 */
export function createSlackMcpServer(
  client: WebClient,
  channelId: string,
  threadTs: string,
  sentMessages?: string[],
) {
  const ctx: SlackToolContext = { client, channelId, threadTs, sentMessages };

  return createSdkMcpServer({
    name: "slack-tools",
    tools: [
      slackSendMessage(ctx),
      slackSendFile(ctx),
      slackListChannels(ctx),
      slackReadChannel(ctx),
      slackReadThread(ctx),
      slackSearch(ctx),
      setInactivityTimeout(ctx),
    ],
  });
}
