import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { SessionRecord } from "./types.js";

const STORE_PATH = join(process.cwd(), ".sessions.json");
const sessions = new Map<string, SessionRecord>();

function makeKey(channelId: string, threadTs: string): string {
  return `${channelId}:${threadTs}`;
}

/** Load sessions from disk into memory */
export function loadSessions(): void {
  try {
    const data = readFileSync(STORE_PATH, "utf-8");
    const records: SessionRecord[] = JSON.parse(data);
    for (const rec of records) {
      sessions.set(makeKey(rec.channelId, rec.threadTs), rec);
    }
    console.log(`Loaded ${sessions.size} sessions from disk`);
  } catch {
    // File doesn't exist yet or is corrupt — start fresh
  }
}

/** Persist sessions to disk atomically (write tmp, rename) */
function persist(): void {
  const records = Array.from(sessions.values());
  const tmp = STORE_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(records, null, 2));
  renameSync(tmp, STORE_PATH);
}

export function getSession(
  channelId: string,
  threadTs: string,
): SessionRecord | undefined {
  return sessions.get(makeKey(channelId, threadTs));
}

export function saveSession(record: SessionRecord): void {
  record.updatedAt = new Date().toISOString();
  sessions.set(makeKey(record.channelId, record.threadTs), record);
  persist();
}
