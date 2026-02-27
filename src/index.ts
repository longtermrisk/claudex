import { createApp } from "./slack/app.js";
import { loadSessions } from "./store/sessions.js";

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

// Start the app
const app = createApp();
await app.start();

console.log("⚡ Claudex is running");
