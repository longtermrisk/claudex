import { createApp } from "./slack/app.js";
import { loadSessions } from "./store/sessions.js";
import { gracefulShutdown } from "./slack/events.js";

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

// Graceful shutdown on SIGTERM: notify active threads, drain, then exit.
// Use `manage.sh slack restart --graceful` to give this handler time to run;
// plain `restart` sends SIGTERM but only waits 5 s before escalating to SIGKILL.
process.on("SIGTERM", async () => {
  console.log("[shutdown] SIGTERM received — starting graceful shutdown");
  try {
    await app.stop(); // stop accepting new Slack events
  } catch (err) {
    console.error("[shutdown] Error stopping Bolt app:", err);
  }
  await gracefulShutdown(app.client);
  process.exit(0);
});
