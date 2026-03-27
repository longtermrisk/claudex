import type { AllMiddlewareArgs, SlackEventMiddlewareArgs } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { getSession, saveSession } from "../store/sessions.js";
import { createSession, resumeSession, summarizeSession } from "../claude/session.js";
import { DEFAULT_INACTIVITY_TIMEOUT_MS } from "../claude/response.js";
import { activeTimeouts } from "./tools.js";
import { resolveCwd } from "../util/paths.js";
import { detectFilePaths } from "../util/file-detect.js";
import { downloadSlackFile, uploadFileToSlack, uploadContentAsFile } from "./files.js";
import { getLatestLogFile, readLastNLines } from "../util/log-reader.js";
import { postToThread, formatForSlack } from "./messages.js";
import { createSlackMcpServer } from "./mcp-server.js";
import { basename } from "node:path";
import { transcribeAudio } from "../util/transcribe.js";
import { truncateContent } from "../util/truncate.js";

/** Concurrency guard: set of thread keys currently being processed */
export const activeThreads = new Set<string>();

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
    const transcripts: string[] = [];
    if ("files" in event && event.files) {
      const token = process.env.SLACK_BOT_TOKEN!;
      for (const file of event.files as Array<{ url_private_download?: string; name?: string; mimetype?: string }>) {
        if (file.url_private_download && file.name) {
          try {
            const localPath = await downloadSlackFile(
              file.url_private_download,
              file.name,
              token,
            );
            if (file.mimetype?.startsWith("audio/")) {
              const transcript = await transcribeAudio(localPath);
              transcripts.push(transcript);
            } else {
              filePaths.push(localPath);
            }
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
      // Aggregate unprocessed messages since last response (also downloads their files)
      const aggregated = await aggregateMessages(
        client,
        channelId,
        threadTs,
        existing.lastResponseTs,
      );
      prompt = truncateContent(aggregated.text, { label: "aggregated messages" });
      filePaths.push(...aggregated.filePaths);
      transcripts.push(...aggregated.transcripts);
    } else if (threadTs !== event.ts) {
      // Mid-thread mention with no existing session — fetch the full thread as context
      const aggregated = await aggregateMessages(
        client,
        channelId,
        threadTs,
        "0", // from the very beginning
      );
      const truncatedHistory = truncateContent(aggregated.text, { label: "full thread history" });
      prompt = `[Slack channel: #${channelName} (${channelId})]\n\n${truncatedHistory}`;
      filePaths.push(...aggregated.filePaths);
      transcripts.push(...aggregated.transcripts);
    } else {
      // First message (top-level) - use the current text
      const rawText = ("text" in event ? event.text : "") ?? "";
      // Strip the bot mention for @mention events
      const messageText = rawText.replace(/<@[A-Z0-9]+>/g, "").trim();
      prompt = `[Slack channel: #${channelName} (${channelId})]\n\n${messageText}`;
    }

    // Append audio transcripts to prompt
    if (transcripts.length > 0) {
      prompt +=
        "\n\nThe user sent a voice message. Here is the transcript:\n" +
        transcripts.map((t) => `Audio transcript: "${t}"`).join("\n");
    }

    // Append file paths to prompt — tell Claude these are local files it can read/view
    if (filePaths.length > 0) {
      prompt +=
        "\n\nThe user attached files to this Slack message. They have been downloaded to local disk. " +
        "You can read/view them using their file paths:\n" +
        filePaths.map((p) => `- ${p}`).join("\n");
    }

    if (!prompt.trim()) {
      // Nothing to process
      if (thinkingTs) {
        await deleteMessage(client, channelId, thinkingTs);
      }
      return;
    }

    // Call Claude with retry on stream failures (fresh MCP server each attempt)
    console.log(`[${threadKey}] Sending to Claude: ${prompt.slice(0, 100)}...`);
    const response = await callClaudeWithRetry(
      client, channelId, threadTs, prompt, cwd, existing,
    );

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

    // Notify if token-based auto-compaction fired during the session
    if (response.didAutoCompact) {
      try {
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: ":information_source: _The context window was getting full — conversation history was automatically compacted to stay within limits._",
        });
      } catch {
        // Best effort — don't let a notification failure block the session save
      }
    }

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

    // Upload full stack trace as a text file
    try {
      const stack = err instanceof Error
        ? (err.stack ?? err.message)
        : String(err);
      await uploadContentAsFile(client, channelId, threadTs, stack, "error-stack.txt");
    } catch {
      // Best effort
    }

    // Upload last 10 000 lines of the service log as a text file
    try {
      const logFile = getLatestLogFile();
      if (logFile) {
        const logTail = readLastNLines(logFile, 10000);
        await uploadContentAsFile(client, channelId, threadTs, logTail, "service-logs.txt");
      }
    } catch {
      // Best effort
    }
  } finally {
    activeThreads.delete(threadKey);
    activeTimeouts.delete(threadKey);
  }
}

/**
 * Gracefully shut down: notify all active threads that claudex is restarting,
 * then wait for them to finish (up to maxWaitMs before giving up).
 */
export async function gracefulShutdown(
  client: WebClient,
  maxWaitMs = 5 * 60 * 1000,
): Promise<void> {
  if (activeThreads.size === 0) return;

  console.log(`[shutdown] Notifying ${activeThreads.size} active thread(s) and waiting for drain...`);

  // Notify all active threads
  const notifications = [...activeThreads].map(async (threadKey) => {
    const [channelId, threadTs] = threadKey.split(":");
    try {
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: "⚠️ claudex is restarting — your session will resume automatically on your next message.",
      });
    } catch (err) {
      console.error(`[shutdown] Failed to notify thread ${threadKey}:`, err);
    }
  });
  await Promise.all(notifications);

  // Wait for active threads to drain
  const deadline = Date.now() + maxWaitMs;
  while (activeThreads.size > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (activeThreads.size > 0) {
    console.warn(`[shutdown] Timed out waiting for ${activeThreads.size} thread(s) to finish — forcing exit`);
  } else {
    console.log("[shutdown] All threads finished, exiting cleanly");
  }
}

interface AggregatedResult {
  text: string;
  filePaths: string[];
  transcripts: string[];
}

/**
 * Aggregate messages from a thread since the last bot response.
 * Returns the prompt text and any downloaded file paths from new user messages.
 */
async function aggregateMessages(
  client: WebClient,
  channelId: string,
  threadTs: string,
  lastResponseTs: string,
): Promise<AggregatedResult> {
  const result = await client.conversations.replies({
    channel: channelId,
    ts: threadTs,
    oldest: lastResponseTs,
  });

  const includeParent = lastResponseTs === "0";
  const userMessages = (result.messages ?? []).filter((m) => {
    // conversations.replies always includes the parent — skip it unless fetching full thread
    if (m.ts === threadTs && !includeParent) return false;
    // Skip bot messages
    if (m.bot_id) return false;
    // Skip messages at or before the last response (oldest is inclusive)
    if (m.ts && m.ts <= lastResponseTs) return false;
    return true;
  });

  // Resolve user IDs to display names, and download any attached files
  const token = process.env.SLACK_BOT_TOKEN!;
  const lines: string[] = [];
  const filePaths: string[] = [];
  const transcripts: string[] = [];

  for (const m of userMessages) {
    const name = m.user ? await resolveUserName(client, m.user) : "unknown";
    const text = (m.text ?? "").replace(/<@[A-Z0-9]+>/g, "").trim();
    if (text) {
      lines.push(`${name}: ${text}`);
    }

    // Download files attached to this message
    const files = (m as { files?: Array<{ url_private_download?: string; name?: string; mimetype?: string }> }).files;
    if (files) {
      for (const file of files) {
        if (file.url_private_download && file.name) {
          try {
            const localPath = await downloadSlackFile(
              file.url_private_download,
              file.name,
              token,
            );
            if (file.mimetype?.startsWith("audio/")) {
              const transcript = await transcribeAudio(localPath);
              transcripts.push(transcript);
            } else {
              filePaths.push(localPath);
            }
          } catch (err) {
            console.error("Failed to download thread file:", err);
          }
        }
      }
    }
  }

  return { text: lines.join("\n"), filePaths, transcripts };
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

/** Call Claude with automatic retry on stream/transport failures */
async function callClaudeWithRetry(
  client: WebClient,
  channelId: string,
  threadTs: string,
  prompt: string,
  cwd: string,
  existing: import("../store/types.js").SessionRecord | undefined,
  maxAttempts = 2,
): Promise<import("../claude/response.js").ClaudeResponse> {
  const threadKey = `${channelId}:${threadTs}`;
  const getTimeoutMs = () => activeTimeouts.get(threadKey) ?? DEFAULT_INACTIVITY_TIMEOUT_MS;
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const slackMcp = createSlackMcpServer(client, channelId, threadTs);
      const sessionOpts = { mcpServers: { "slack-tools": slackMcp } };
      const response = existing
        ? await resumeSession(prompt, cwd, existing.sessionId, sessionOpts, getTimeoutMs)
        : await createSession(prompt, cwd, sessionOpts, getTimeoutMs);

      // Graceful recovery when the turn limit is hit:
      //  1. Resume the session (which still has the full recent context) to generate a summary.
      //     The summary covers both what was done and what was in progress — capturing the
      //     "second half" of the context that auto-compaction hadn't touched yet.
      //  2. Upload the summary as a file attachment so it's readable even if it's long.
      //  3. Start a fresh continuation session using the summary as context, so the task
      //     can resume without the ballooning history that caused the limit to be hit.
      if (response.subtype === "error_max_turns" && response.sessionId) {
        console.warn(`[${threadKey}] Turn limit reached — summarising session ${response.sessionId} and continuing`);
        try {
          const summaryMcp = createSlackMcpServer(client, channelId, threadTs);
          const summary = await summarizeSession(cwd, response.sessionId, {
            mcpServers: { "slack-tools": summaryMcp },
          });

          if (!summary.isError && summary.text) {
            // Upload the full summary as a file (may be long)
            await uploadContentAsFile(
              client, channelId, threadTs, summary.text, "session-summary.txt",
            );

            // Start a fresh session using the summary as context and continue the work.
            // This deliberately does NOT re-enter the error_max_turns recovery path —
            // if the continuation also hits the limit the caller receives that error directly.
            const continuationPrompt =
              "The previous session reached the turn limit. Here is a summary of what was " +
              "accomplished and what was left in progress:\n\n" +
              summary.text +
              "\n\nPlease continue from where things left off, completing the original task.";
            const continuationMcp = createSlackMcpServer(client, channelId, threadTs);
            const continuation = await createSession(continuationPrompt, cwd, {
              mcpServers: { "slack-tools": continuationMcp },
            }, getTimeoutMs);

            return {
              ...continuation,
              costUsd: response.costUsd + summary.costUsd + continuation.costUsd,
            };
          }
        } catch (summaryErr) {
          console.error(`[${threadKey}] Failed to summarise / continue after turn limit:`, summaryErr);
        }
      }

      return response;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (!/stream closed/i.test(msg) || attempt === maxAttempts - 1) throw err;
      console.warn(`[${channelId}:${threadTs}] Stream closed, retrying with fresh MCP server (attempt ${attempt + 2}/${maxAttempts})`);
    }
  }
  throw lastErr;
}
