import { createApp } from "./slack/app.js";
import { loadSessions } from "./store/sessions.js";
import { startGitHubWebhookServer } from "./github/handler.js";

// Validate required env vars
const required = ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "ANTHROPIC_API_KEY"];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

// Load persisted sessions
loadSessions();

// Start the Slack Socket Mode app
const app = createApp();
await app.start();

// Optionally start the GitHub webhook HTTP server (same process, second I/O channel)
if (process.env.GITHUB_TOKEN) {
  const port = parseInt(process.env.GITHUB_WEBHOOK_PORT ?? "8080", 10);
  startGitHubWebhookServer(port);
} else {
  console.log("GITHUB_TOKEN not set — GitHub webhook server disabled");
}

console.log("⚡ Claudex is running");
