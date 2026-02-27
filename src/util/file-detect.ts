import { existsSync } from "node:fs";

/**
 * Detect absolute file paths mentioned in text that actually exist on disk.
 * Returns deduplicated list of existing paths.
 */
export function detectFilePaths(text: string): string[] {
  const pattern = /(?:^|\s)(\/[\w./-]+\.\w+)/gm;
  const seen = new Set<string>();
  const results: string[] = [];

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const path = match[1]!;
    if (!seen.has(path) && existsSync(path)) {
      seen.add(path);
      results.push(path);
    }
  }

  return results;
}
