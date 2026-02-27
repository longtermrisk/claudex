import pkg from "@slack/bolt";
const { App, LogLevel } = pkg;
import { handleMessage } from "./events.js";

/**
 * Create and configure the Bolt app with Socket Mode.
 */
export function createApp() {
  const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    socketMode: true,
    logLevel: LogLevel.DEBUG,
  });

  // Handle @mentions in channels
  app.event("app_mention", async (args) => {
    console.log("[app_mention] Received event from", args.event.user, "in", args.event.channel);
    await handleMessage(args);
  });

  // Handle DMs (only direct messages, not channel messages)
  app.event("message", async (args) => {
    const { event } = args;
    console.log("[message] Received event:", JSON.stringify(event).slice(0, 300));
    if ("channel_type" in event && event.channel_type === "im") {
      console.log("[message] Processing DM from", "user" in event ? event.user : "unknown");
      await handleMessage(args);
    }
  });

  // Catch unhandled errors
  app.error(async (error) => {
    console.error("[app.error]", error);
  });

  return app;
}
