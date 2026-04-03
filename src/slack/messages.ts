import type { WebClient } from "@slack/web-api";

const SLACK_MAX_LENGTH = 3900; // Leave room for formatting overhead under the 4000 char limit

/**
 * Post a message (or multiple messages if long) to a Slack thread.
 * Returns the timestamp of the last message posted.
 */
export async function postToThread(
  client: WebClient,
  channelId: string,
  threadTs: string,
  text: string,
): Promise<string> {
  const formatted = formatForSlack(text);
  const chunks = splitMessage(formatted, SLACK_MAX_LENGTH);
  let lastTs = "";

  for (const chunk of chunks) {
    const res = await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: chunk,
    });
    if (!res.ts) {
      throw new Error("Slack returned no timestamp for the posted message chunk");
    }
    lastTs = res.ts;
  }

  return lastTs;
}

/**
 * Convert markdown-style formatting to Slack mrkdwn.
 */
export function formatForSlack(text: string): string {
  return (
    text
      // Code blocks: preserve as-is (Slack supports ```)
      // Bold: **text** → *text*
      .replace(/\*\*(.+?)\*\*/g, "*$1*")
      // Headings: ### Heading → *Heading*
      .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
      // Links: [text](url) → <url|text>
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>")
  );
}

/**
 * Split a long message into chunks that fit within Slack's limits.
 * Tries to split at newlines for readability.
 */
function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Try to break at a newline near the limit
    let splitIdx = remaining.lastIndexOf("\n", maxLen);
    if (splitIdx < maxLen * 0.5) {
      // No good newline break, split at limit
      splitIdx = maxLen;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).replace(/^\n/, "");
  }

  return chunks;
}
