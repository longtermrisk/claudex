import type { AllMiddlewareArgs, SlackEventMiddlewareArgs } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { getSession, saveSession } from "../store/sessions.js";
import { createSession, resumeSession } from "../claude/session.js";
import { resolveCwd } from "../util/paths.js";
import { detectFilePaths } from "../util/file-detect.js";
import { downloadSlackFile, uploadFileToSlack } from "./files.js";
import { postToThread, formatForSlack } from "./messages.js";
import { basename } from "node:path";

/** Concurrency guard: set of thread keys currently being processed */
const activeThreads = new Set<string>();

/** Cache for workspace/channel names */
const nameCache = new Map<string, string>();

type MessageEvent = SlackEventMiddlewareArgs<"message"> & AllMiddlewareArgs;
type MentionEvent = SlackEventMiddlewareArgs<"app_mention"> & AllMiddlewareArgs;

/**
 * Handle an incoming message (DM or @mention).
 */
export async function handleMessage(
  args: MessageEvent | MentionEvent,
): Promise<void> {
  const { client, event } = args;

  // Ignore bot messages, message_changed, etc.
  if ("subtype" in event && event.subtype) return;
  if ("bot_id" in event && event.bot_id) return;

  const channelId = event.channel;
  const threadTs = ("thread_ts" in event && event.thread_ts) ? event.thread_ts : event.ts;
  const threadKey = `${channelId}:${threadTs}`;

  // Concurrency guard
  if (activeThreads.has(threadKey)) {
    console.log(`Thread ${threadKey} already processing, skipping`);
    return;
  }

  activeThreads.add(threadKey);
  let thinkingTs: string | undefined;

  try {
    // Post thinking indicator
    const thinkingRes = await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: ":hourglass_flowing_sand: Thinking...",
    });
    thinkingTs = thinkingRes.ts ?? undefined;

    // Download any attached files
    const filePaths: string[] = [];
    if ("files" in event && event.files) {
      const token = process.env.SLACK_BOT_TOKEN!;
      for (const file of event.files as Array<{ url_private_download?: string; name?: string }>) {
        if (file.url_private_download && file.name) {
          try {
            const localPath = await downloadSlackFile(
              file.url_private_download,
              file.name,
              token,
            );
            filePaths.push(localPath);
          } catch (err) {
            console.error("Failed to download file:", err);
          }
        }
      }
    }

    // Resolve CWD
    const workspaceName = await getCachedName("workspace", async () => {
      const info = await client.team.info();
      return (info.team as { name?: string })?.name ?? "workspace";
    });
    const channelName = await getCachedName(`channel:${channelId}`, async () => {
      const info = await client.conversations.info({ channel: channelId });
      return info.channel?.name ?? channelId;
    });
    const cwd = resolveCwd(workspaceName, channelName);

    // Build prompt
    const existing = getSession(channelId, threadTs);
    let prompt: string;

    if (existing) {
      // Aggregate unprocessed messages since last response
      prompt = await aggregateMessages(
        client,
        channelId,
        threadTs,
        existing.lastResponseTs,
      );
    } else {
      // First message - use the current text
      const rawText = ("text" in event ? event.text : "") ?? "";
      // Strip the bot mention for @mention events
      prompt = rawText.replace(/<@[A-Z0-9]+>/g, "").trim();
    }

    // Append file paths to prompt
    if (filePaths.length > 0) {
      prompt += "\n\nAttached files:\n" + filePaths.map((p) => `- ${p}`).join("\n");
    }

    if (!prompt.trim()) {
      // Nothing to process
      if (thinkingTs) {
        await deleteMessage(client, channelId, thinkingTs);
      }
      return;
    }

    // Call Claude
    console.log(`[${threadKey}] Sending to Claude: ${prompt.slice(0, 100)}...`);
    const response = existing
      ? await resumeSession(prompt, cwd, existing.sessionId)
      : await createSession(prompt, cwd);

    // Remove thinking indicator
    if (thinkingTs) {
      await deleteMessage(client, channelId, thinkingTs);
      thinkingTs = undefined;
    }

    // Post response
    const responseTs = await postToThread(
      client,
      channelId,
      threadTs,
      response.text,
    );

    // Detect file paths in response and upload them
    const detectedPaths = detectFilePaths(response.text);
    for (const filePath of detectedPaths) {
      try {
        await uploadFileToSlack(
          client,
          channelId,
          threadTs,
          filePath,
          basename(filePath),
        );
      } catch (err) {
        console.error(`Failed to upload ${filePath}:`, err);
      }
    }

    // Save session
    saveSession({
      threadTs,
      channelId,
      sessionId: response.sessionId,
      cwd,
      lastResponseTs: responseTs,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    if (response.costUsd > 0) {
      console.log(`[${threadKey}] Cost: $${response.costUsd.toFixed(4)}`);
    }
  } catch (err) {
    console.error(`Error handling thread ${threadKey}:`, err);

    // Remove thinking indicator on error
    if (thinkingTs) {
      await deleteMessage(client, channelId, thinkingTs);
    }

    // Post error message
    try {
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `:x: Sorry, something went wrong: ${err instanceof Error ? err.message : "Unknown error"}`,
      });
    } catch {
      // If we can't even post the error, just log it
    }
  } finally {
    activeThreads.delete(threadKey);
  }
}

/**
 * Aggregate messages from a thread since the last bot response.
 * Returns a prompt with only the new, unprocessed user messages.
 */
async function aggregateMessages(
  client: WebClient,
  channelId: string,
  threadTs: string,
  lastResponseTs: string,
): Promise<string> {
  const result = await client.conversations.replies({
    channel: channelId,
    ts: threadTs,
    oldest: lastResponseTs,
  });

  const userMessages = (result.messages ?? []).filter((m) => {
    // conversations.replies always includes the parent — skip it
    if (m.ts === threadTs) return false;
    // Skip bot messages
    if (m.bot_id) return false;
    // Skip messages at or before the last response (oldest is inclusive)
    if (m.ts && m.ts <= lastResponseTs) return false;
    return true;
  });

  // Resolve user IDs to display names
  const lines: string[] = [];
  for (const m of userMessages) {
    const name = m.user ? await resolveUserName(client, m.user) : "unknown";
    const text = (m.text ?? "").replace(/<@[A-Z0-9]+>/g, "").trim();
    if (text) {
      lines.push(`${name}: ${text}`);
    }
  }

  return lines.join("\n");
}

/** Resolve a Slack user ID to a display name, with caching */
async function resolveUserName(
  client: WebClient,
  userId: string,
): Promise<string> {
  const cached = nameCache.get(`user:${userId}`);
  if (cached) return cached;
  const info = await client.users.info({ user: userId });
  const name =
    info.user?.profile?.display_name ||
    info.user?.real_name ||
    info.user?.name ||
    userId;
  nameCache.set(`user:${userId}`, name);
  return name;
}

async function getCachedName(
  key: string,
  fetcher: () => Promise<string>,
): Promise<string> {
  const cached = nameCache.get(key);
  if (cached) return cached;
  const name = await fetcher();
  nameCache.set(key, name);
  return name;
}

async function deleteMessage(
  client: WebClient,
  channel: string,
  ts: string,
): Promise<void> {
  try {
    await client.chat.delete({ channel, ts });
  } catch {
    // Best effort — may fail if message was already deleted
  }
}
