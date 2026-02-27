import { mkdirSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { WebClient } from "@slack/web-api";

/**
 * Download a Slack file to a temp directory.
 * Returns the local path of the downloaded file.
 */
export async function downloadSlackFile(
  url: string,
  filename: string,
  token: string,
): Promise<string> {
  const dir = join("/tmp", randomUUID());
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, filename);

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok || !res.body) {
    throw new Error(`Failed to download file: ${res.status} ${res.statusText}`);
  }

  const readable = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
  await pipeline(readable, createWriteStream(dest));
  return dest;
}

/**
 * Upload a local file to a Slack thread.
 */
export async function uploadFileToSlack(
  client: WebClient,
  channelId: string,
  threadTs: string,
  filePath: string,
  filename: string,
): Promise<void> {
  await client.filesUploadV2({
    channel_id: channelId,
    thread_ts: threadTs,
    file: filePath,
    filename,
  });
}
