import { z } from "zod/v4";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { WebClient } from "@slack/web-api";

export interface SlackToolContext {
  client: WebClient;
  channelId: string;
  threadTs: string;
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Cache of user ID → display name, shared across tool calls within a session */
const userNameCache = new Map<string, string>();

async function resolveUserName(client: WebClient, userId: string): Promise<string> {
  const cached = userNameCache.get(userId);
  if (cached) return cached;
  try {
    const info = await client.users.info({ user: userId });
    const name =
      info.user?.profile?.display_name ||
      info.user?.real_name ||
      info.user?.name ||
      userId;
    userNameCache.set(userId, name);
    return name;
  } catch {
    return userId;
  }
}

/** Resolve all user IDs in an array of message objects */
async function resolveMessageUsers<T extends { user: string }>(
  client: WebClient,
  messages: T[],
): Promise<T[]> {
  const uniqueIds = [...new Set(messages.map((m) => m.user))];
  await Promise.all(uniqueIds.map((id) => resolveUserName(client, id)));
  return messages.map((m) => ({
    ...m,
    user: userNameCache.get(m.user) ?? m.user,
  }));
}

export function slackSendMessage(ctx: SlackToolContext) {
  return tool(
    "slack_send_message",
    "Send a message to a Slack channel or thread. Defaults to the current thread if channel_id and thread_ts are not provided.",
    {
      text: z.string().describe("The message text to send (supports Slack mrkdwn)"),
      channel_id: z.optional(z.string().describe("Channel ID to send to (defaults to current channel)")),
      thread_ts: z.optional(z.string().describe("Thread timestamp to reply in (defaults to current thread)")),
    },
    async (args) => {
      try {
        const channel = args.channel_id ?? ctx.channelId;
        const threadTs = args.thread_ts ?? ctx.threadTs;
        const result = await ctx.client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: args.text,
        });
        return {
          content: [{ type: "text" as const, text: `Message sent (ts: ${result.ts})` }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Failed to send message: ${formatError(err)}` }],
          isError: true,
        };
      }
    },
  );
}

export function slackSendFile(ctx: SlackToolContext) {
  return tool(
    "slack_send_file",
    "Upload a file to a Slack channel or thread. Defaults to the current thread if channel_id and thread_ts are not provided.",
    {
      file_path: z.string().describe("Absolute path to the file to upload"),
      filename: z.optional(z.string().describe("Display filename (defaults to basename of file_path)")),
      channel_id: z.optional(z.string().describe("Channel ID to upload to (defaults to current channel)")),
      thread_ts: z.optional(z.string().describe("Thread timestamp (defaults to current thread)")),
    },
    async (args) => {
      try {
        const channel = args.channel_id ?? ctx.channelId;
        const threadTs = args.thread_ts ?? ctx.threadTs;
        const { basename } = await import("node:path");
        const filename = args.filename ?? basename(args.file_path);
        await ctx.client.filesUploadV2({
          channel_id: channel,
          thread_ts: threadTs,
          file: args.file_path,
          filename,
        });
        return {
          content: [{ type: "text" as const, text: `File "${filename}" uploaded successfully.` }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Failed to upload file: ${formatError(err)}` }],
          isError: true,
        };
      }
    },
  );
}

export function slackListChannels(ctx: SlackToolContext) {
  return tool(
    "slack_list_channels",
    "List public channels in the Slack workspace that the bot has access to.",
    {
      limit: z.optional(z.number().describe("Max channels to return (default 100, max 1000)")),
    },
    async (args) => {
      try {
        const result = await ctx.client.conversations.list({
          types: "public_channel",
          exclude_archived: true,
          limit: args.limit ?? 100,
        });
        const channels = (result.channels ?? []).map((ch) => ({
          id: ch.id,
          name: ch.name,
          topic: ch.topic?.value || "",
          num_members: ch.num_members,
        }));
        return {
          content: [{ type: "text" as const, text: JSON.stringify(channels, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Failed to list channels: ${formatError(err)}` }],
          isError: true,
        };
      }
    },
  );
}

export function slackReadChannel(ctx: SlackToolContext) {
  return tool(
    "slack_read_channel",
    "Read recent messages from a Slack channel. Returns messages in chronological order.",
    {
      channel_id: z.string().describe("Channel ID to read from"),
      limit: z.optional(z.number().describe("Number of messages to retrieve (default 20, max 100)")),
    },
    async (args) => {
      try {
        const result = await ctx.client.conversations.history({
          channel: args.channel_id,
          limit: args.limit ?? 20,
        });
        const messages = (result.messages ?? []).reverse().map((m) => ({
          ts: m.ts,
          user: m.user ?? m.bot_id ?? "unknown",
          text: m.text ?? "",
          thread_ts: m.thread_ts,
          reply_count: m.reply_count,
        }));
        const resolved = await resolveMessageUsers(ctx.client, messages);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(resolved, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Failed to read channel: ${formatError(err)}` }],
          isError: true,
        };
      }
    },
  );
}

export function slackReadThread(ctx: SlackToolContext) {
  return tool(
    "slack_read_thread",
    "Read messages from a specific Slack thread.",
    {
      channel_id: z.string().describe("Channel ID containing the thread"),
      thread_ts: z.string().describe("Thread parent timestamp"),
      limit: z.optional(z.number().describe("Number of replies to retrieve (default 50, max 200)")),
    },
    async (args) => {
      try {
        const result = await ctx.client.conversations.replies({
          channel: args.channel_id,
          ts: args.thread_ts,
          limit: args.limit ?? 50,
        });
        const messages = (result.messages ?? []).map((m) => ({
          ts: m.ts,
          user: m.user ?? m.bot_id ?? "unknown",
          text: m.text ?? "",
        }));
        const resolved = await resolveMessageUsers(ctx.client, messages);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(resolved, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Failed to read thread: ${formatError(err)}` }],
          isError: true,
        };
      }
    },
  );
}

export function slackSearch(ctx: SlackToolContext) {
  return tool(
    "slack_search",
    "Search for messages in Slack. Uses the Search API if a user token is available, otherwise falls back to scanning channel history with keyword filtering (requires channel_id).",
    {
      query: z.string().describe("Search query string"),
      channel_id: z.optional(z.string().describe("Channel ID to search in (required if no user token is set)")),
      limit: z.optional(z.number().describe("Max results to return (default 20)")),
    },
    async (args) => {
      const limit = args.limit ?? 20;

      try {
        // Try search.messages with user token if available
        const userToken = process.env.SLACK_USER_TOKEN;
        if (userToken) {
          const { WebClient } = await import("@slack/web-api");
          const userClient = new WebClient(userToken);
          const searchQuery = args.channel_id
            ? `in:<#${args.channel_id}> ${args.query}`
            : args.query;
          const result = await userClient.search.messages({
            query: searchQuery,
            count: limit,
            sort: "timestamp",
            sort_dir: "desc",
          });
          const matches = (result.messages?.matches ?? []).map((m) => ({
            ts: m.ts,
            channel: (m.channel as { id?: string })?.id,
            user: m.user ?? "unknown",
            text: m.text ?? "",
            permalink: m.permalink,
          }));
          const resolved = await resolveMessageUsers(ctx.client, matches);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(resolved, null, 2) }],
          };
        }

        // Fallback: scan channel history with keyword filter
        if (!args.channel_id) {
          return {
            content: [{
              type: "text" as const,
              text: "No SLACK_USER_TOKEN set. Please provide a channel_id to search within using history scan.",
            }],
            isError: true,
          };
        }

        const keywords = args.query.toLowerCase().split(/\s+/);
        const result = await ctx.client.conversations.history({
          channel: args.channel_id,
          limit: 200, // scan more messages to find matches
        });

        const matches = (result.messages ?? [])
          .filter((m) => {
            const text = (m.text ?? "").toLowerCase();
            return keywords.some((kw) => text.includes(kw));
          })
          .slice(0, limit)
          .reverse()
          .map((m) => ({
            ts: m.ts,
            user: m.user ?? m.bot_id ?? "unknown",
            text: m.text ?? "",
            thread_ts: m.thread_ts,
          }));

        const resolved = await resolveMessageUsers(ctx.client, matches);
        return {
          content: [{
            type: "text" as const,
            text: resolved.length > 0
              ? JSON.stringify(resolved, null, 2)
              : `No messages matching "${args.query}" found in recent history.`,
          }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Search failed: ${formatError(err)}` }],
          isError: true,
        };
      }
    },
  );
}
