import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { getSession, saveSession } from "../store/sessions.js";
import { createSession, resumeSession } from "../claude/session.js";
import { resolveCwd } from "../util/paths.js";
import { postGitHubComment } from "./post.js";

const BOT_HANDLE = process.env.GITHUB_BOT_HANDLE ?? "@claudex";

/** Concurrency guard: set of thread keys currently being processed */
const activeThreads = new Set<string>();

/** Verify the X-Hub-Signature-256 header from GitHub */
async function verifySignature(req: IncomingMessage, body: string): Promise<boolean> {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    console.warn("[github] GITHUB_WEBHOOK_SECRET not set — skipping signature verification");
    return true;
  }
  const sig = req.headers["x-hub-signature-256"] as string | undefined;
  if (!sig) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

/** Read the full request body */
async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

/** Handle a single webhook HTTP request */
export async function handleWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== "POST" || req.url !== "/github/webhook") {
    res.writeHead(404).end();
    return;
  }

  const body = await readBody(req);

  if (!(await verifySignature(req, body))) {
    console.warn("[github] Webhook signature verification failed");
    res.writeHead(401).end("Unauthorized");
    return;
  }

  // Respond immediately so GitHub doesn't time out
  res.writeHead(200).end("ok");

  const event = req.headers["x-github-event"] as string | undefined;

  // Only handle new comments on issues and PRs for now.
  // pull_request_review_comment (inline diff comments) can be added later.
  if (event !== "issue_comment") return;

  const payload = JSON.parse(body);
  if (payload.action !== "created") return; // ignore edits / deletions

  const commentBody: string = payload.comment?.body ?? "";
  if (!commentBody.includes(BOT_HANDLE)) return;

  const repo: string = payload.repository.full_name; // "owner/repo"
  const issueNumber: string = String(payload.issue.number);
  const commentsUrl: string = payload.issue.comments_url;
  const user: string = payload.comment.user.login;

  // Session key: channelId = "gh:owner/repo", threadTs = issue/PR number.
  // This slots naturally into the existing session store without any schema changes.
  const channelId = `gh:${repo}`;
  const threadTs = issueNumber;
  const threadKey = `${channelId}:${threadTs}`;

  if (activeThreads.has(threadKey)) {
    console.log(`[github] ${threadKey} already processing, skipping`);
    return;
  }

  activeThreads.add(threadKey);
  try {
    const existing = getSession(channelId, threadTs);

    // Working directory mirrors the Slack pattern: ~/github/{owner}-{repo}/
    const cwd = resolveCwd("github", repo.replace("/", "-"));

    // Strip the bot mention from the comment text
    const text = commentBody.replace(new RegExp(BOT_HANDLE, "g"), "").trim();
    const prompt = `[GitHub ${repo}#${issueNumber}]\n\n${user}: ${text}`;

    console.log(`[github] ${threadKey} sending to Claude: ${prompt.slice(0, 120)}...`);

    const response = existing
      ? await resumeSession(prompt, cwd, existing.sessionId)
      : await createSession(prompt, cwd);

    await postGitHubComment(commentsUrl, response.text);

    saveSession({
      channelId,
      threadTs,
      sessionId: response.sessionId,
      cwd,
      // lastResponseTs isn't used for GitHub sessions (no message aggregation needed),
      // but the field is required — store the wall-clock time for debugging.
      lastResponseTs: new Date().toISOString(),
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    if (response.costUsd > 0) {
      console.log(`[github] ${threadKey} cost: $${response.costUsd.toFixed(4)}`);
    }
  } catch (err) {
    console.error(`[github] Error handling ${threadKey}:`, err);
    try {
      await postGitHubComment(
        commentsUrl,
        `> ❌ Claudex error: ${err instanceof Error ? err.message : "Unknown error"}`,
      );
    } catch {
      // Best effort — don't let a reply failure mask the original error
    }
  } finally {
    activeThreads.delete(threadKey);
  }
}

/** Start the GitHub webhook HTTP server on the given port */
export function startGitHubWebhookServer(port: number): void {
  const server = createServer(async (req, res) => {
    try {
      await handleWebhookRequest(req, res);
    } catch (err) {
      console.error("[github] Unhandled webhook error:", err);
      if (!res.headersSent) res.writeHead(500).end("Internal server error");
    }
  });

  server.listen(port, () => {
    console.log(`⚡ GitHub webhook server listening on port ${port}`);
  });
}
