import { mkdirSync, existsSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const BASE_DIR = homedir();
const SKILLS_CLAUDE_MD = join(homedir(), ".claude", "skills", "CLAUDE.md");

/**
 * Resolve working directory for a session: ~/{workspace}/{channel}
 * Creates the directory if needed and copies CLAUDE.md into it.
 */
export function resolveCwd(
  workspaceName: string,
  channelName: string,
): string {
  // Hardcoded exception: claudex-dev channel runs in ~/
  if (sanitize(channelName) === "claudex-dev") {
    return BASE_DIR;
  }

  const dir = join(BASE_DIR, sanitize(workspaceName), sanitize(channelName));

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    console.log(`Created working directory: ${dir}`);
  }

  const claudeMdDest = join(dir, "CLAUDE.md");
  if (!existsSync(claudeMdDest) && existsSync(SKILLS_CLAUDE_MD)) {
    copyFileSync(SKILLS_CLAUDE_MD, claudeMdDest);
    console.log(`Copied CLAUDE.md to ${dir}`);
  }

  return dir;
}

/** Sanitize a name for use as a directory component */
function sanitize(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}
