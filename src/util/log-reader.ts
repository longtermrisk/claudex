import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Find the most recently modified service log file in the logs/ directory.
 * Returns null if no log files are found.
 */
export function getLatestLogFile(): string | null {
  const logsDir = join(process.cwd(), "logs");
  try {
    const files = readdirSync(logsDir)
      .filter((f) => f.startsWith("service_") && f.endsWith(".log"))
      .map((f) => {
        const fullPath = join(logsDir, f);
        return { path: fullPath, mtime: statSync(fullPath).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    return files.length > 0 ? files[0].path : null;
  } catch {
    return null;
  }
}

/**
 * Read the last N lines from a text file.
 * Returns an error string if the file cannot be read.
 */
export function readLastNLines(filePath: string, n: number): string {
  try {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    return lines.slice(Math.max(0, lines.length - n)).join("\n");
  } catch (err) {
    return `[Failed to read log file: ${err instanceof Error ? err.message : String(err)}]`;
  }
}
